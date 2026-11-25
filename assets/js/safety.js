// 风险区是启发式演示数据：真实事故与施工数据没有免费接口，后续接交警或高德交通事件时只替换这个数组，评分逻辑不动。
const RISK_ZONES = [
  { lat: 39.8961, lng: 116.3304, radius: 500, type: 'construction', label: '广安路地铁施工段' },
  { lat: 39.8994, lng: 116.3975, radius: 450, type: 'accident', label: '崇文门–前门事故多发段' },
  { lat: 39.9322, lng: 116.3562, radius: 500, type: 'accident', label: '西二环官园桥事故多发段' },
  { lat: 39.8853, lng: 116.4133, radius: 600, type: 'pedestrian', label: '天坛东门步行密集区' },
  { lat: 31.2072, lng: 121.4063, radius: 600, type: 'construction', label: '延安路高架施工段' },
  { lat: 31.2304, lng: 121.4737, radius: 800, type: 'pedestrian', label: '人民广场步行区' },
  { lat: 31.236, lng: 121.505, radius: 500, type: 'construction', label: '世纪大道施工段' },
  { lat: 23.13, lng: 113.325, radius: 600, type: 'construction', label: '天河路施工段' },
  { lat: 30.581, lng: 114.27, radius: 600, type: 'accident', label: '中山大道事故多发段' },
  { lat: 34.756, lng: 113.665, radius: 700, type: 'pedestrian', label: '二七广场步行密集区' },
];

const RISK_PENALTY = { construction: 12, accident: 12, pedestrian: 8 };
const WEATHER_PENALTY = {
  drive: { 毛毛雨: 8, 雨: 10, 阵雨: 10, 雷雨: 14, 雪: 12, 阵雪: 12, 雾: 8, 霾: 6 },
  walk: { 毛毛雨: 12, 雨: 14, 阵雨: 14, 雷雨: 18, 雪: 16, 阵雪: 16, 雾: 10, 霾: 8 },
};
const WET_TEXTS = new Set(['毛毛雨', '雨', '阵雨', '雷雨', '雪', '阵雪']);
const SNOW_TEXTS = new Set(['雪', '阵雪']);
const WIND_TIERS = [
  { min: 62, level: 10, drive: 12, walk: 18 },
  { min: 39, level: 7, drive: 8, walk: 12 },
  { min: 20, level: 5, drive: 0, walk: 4 },
];
const NIGHT_PENALTY = { drive: 0, walk: 6 };
const ICE_PENALTY = { wet: { drive: 16, walk: 20 }, cold: { drive: 8, walk: 12 }, nearFreezing: { drive: 8, walk: 10 } };
const PEAK_PENALTY = 8;
const LONG_ROUTE_START = 15000;
const LONG_ROUTE_STEP = 5000;
const LONG_ROUTE_UNIT = 3;
const LONG_ROUTE_CAP = 9;

function scoreGrade(score) {
  if (score >= 85) return { label: '优', tone: 'high' };
  if (score >= 70) return { label: '良', tone: 'mid' };
  return { label: '中', tone: 'low' };
}

function isPeakHour(hour) {
  return (hour >= 7 && hour < 9) || (hour >= 17 && hour < 19);
}

function isNightHour(hour) {
  return hour < 6 || hour >= 20;
}

function crossedRiskZones(points) {
  return RISK_ZONES.filter((zone) =>
    points.some((point) => distanceBetween(point, zone) <= zone.radius),
  );
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isWet(weather) {
  return numberOr(weather.precipitation, 0) > 0.05
    || numberOr(weather.maxProb, 0) >= 50
    || WET_TEXTS.has(weather.text);
}

function iceRisk(weather) {
  if (!weather) return null;
  const temp = numberOr(weather.temp, NaN);
  const feels = numberOr(weather.feels, NaN);
  const coldest = Math.min(temp, feels);
  if (!Number.isFinite(coldest)) return null;

  const wet = isWet(weather);
  if (coldest <= 0 && wet) {
    const label = SNOW_TEXTS.has(weather.text) ? '积雪路滑' : `路面结冰（体感 ${Number.isFinite(feels) ? feels : coldest}°）`;
    return { label, ...ICE_PENALTY.wet };
  }
  if (coldest <= 0) return { label: '低温', ...ICE_PENALTY.cold };
  if (coldest <= 3 && wet) return { label: '近冰点，注意暗冰', ...ICE_PENALTY.nearFreezing };
  return null;
}

function windRisk(weather) {
  const wind = numberOr(weather?.wind, NaN);
  if (!Number.isFinite(wind)) return null;
  const tier = WIND_TIERS.find((item) => wind >= item.min);
  return tier ? { label: `大风 ${tier.level} 级`, drive: tier.drive, walk: tier.walk } : null;
}

function scoreRoute(points, options = {}) {
  const hour = Number.isFinite(options.hour) ? options.hour : new Date().getHours();
  const weather = options.weather ?? null;
  const mode = options.mode === 'walk' ? 'walk' : 'drive';
  const factors = [];
  let penalty = 0;

  const add = (type, label, weight) => {
    if (!(weight > 0)) return;
    penalty += weight;
    factors.push({ type, label, weight });
  };

  for (const zone of crossedRiskZones(points)) {
    add(zone.type, `途经${zone.label}`, RISK_PENALTY[zone.type] ?? 0);
  }

  if (isPeakHour(hour)) add('peak', `早晚高峰（${hour} 点）`, PEAK_PENALTY);

  if (weather?.text) add('weather', `起点天气：${weather.text}`, WEATHER_PENALTY[mode][weather.text] ?? 0);

  const ice = iceRisk(weather, mode);
  if (ice) add('ice', ice.label, ice[mode]);

  const wind = windRisk(weather);
  if (wind) add('wind', wind.label, wind[mode]);

  if (isNightHour(hour)) add('night', '夜间，能见度低', NIGHT_PENALTY[mode]);

  const { total } = buildRouteMetrics(points);
  if (total > LONG_ROUTE_START) {
    const over = Math.ceil((total - LONG_ROUTE_START) / LONG_ROUTE_STEP);
    add('length', `路线较长（${(total / 1000).toFixed(1)} km）`, Math.min(LONG_ROUTE_CAP, over * LONG_ROUTE_UNIT));
  }

  const score = Math.max(0, Math.round(100 - penalty));
  if (!factors.length) factors.push({ type: 'clear', label: '无明显风险因子', weight: 0 });

  return { score, grade: scoreGrade(score).label, factors };
}
