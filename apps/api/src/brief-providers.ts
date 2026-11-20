export type BriefSource = { kind: "personal_record" | "weather" | "external_brief" | "search" | "subscription"; label: string; url?: string; provider?: string; retrievedAt?: string };
export type BriefSection = { title: string; body: string };
export type BriefLocation = { name: string; latitude: number; longitude: number; timeZone: string };
export type BriefWeather = { temperatureCelsius: number; apparentTemperatureCelsius: number; weatherCode: number; observedAt: string | null };
export type WeatherResult = { section: BriefSection; source: BriefSource | null; location: BriefLocation | null; weather: BriefWeather | null };
export type BriefDailyForecast = { localDate: string; minimumCelsius: number; maximumCelsius: number; precipitationProbabilityPercent: number | null; weatherCode: number };
export type WeeklyWeatherResult = { source: BriefSource | null; location: BriefLocation | null; days: BriefDailyForecast[] };

export class BriefProviders {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async weather(locationName?: string): Promise<WeatherResult> {
    const query = locationName?.trim();
    if (!query) return { section: { title: "天气与地点", body: "今日未记录地点。" }, source: null, location: null, weather: null };
    try {
      const geocodingResponse = await this.fetcher(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`, { signal: AbortSignal.timeout(8_000) });
      if (!geocodingResponse.ok) throw new Error("geocoding_response_failed");
      const geocoding = await geocodingResponse.json() as { results?: Array<{ name?: string; admin1?: string; country?: string; latitude?: number; longitude?: number; timezone?: string }> };
      const match = geocoding.results?.[0];
      if (!match?.name || match.latitude === undefined || match.longitude === undefined || !match.timezone) {
        return { section: { title: "天气与地点", body: `没有找到“${query}”，请检查地点名称。` }, source: null, location: null, weather: null };
      }
      const name = formatLocationName([match.name, match.admin1, match.country]);
      const location = { name, latitude: match.latitude, longitude: match.longitude, timeZone: match.timezone };
      const response = await this.fetcher(`https://api.open-meteo.com/v1/forecast?latitude=${match.latitude}&longitude=${match.longitude}&current=temperature_2m,apparent_temperature,weather_code&timezone=auto`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("weather_response_failed");
      const data = await response.json() as { timezone?: string; current?: { time?: string; temperature_2m?: number; apparent_temperature?: number; weather_code?: number } };
      const current = data.current;
      if (!current || current.temperature_2m === undefined) throw new Error("weather_payload_missing");
      const observedTimeZone = data.timezone ?? match.timezone;
      const weather = {
        temperatureCelsius: current.temperature_2m,
        apparentTemperatureCelsius: current.apparent_temperature ?? current.temperature_2m,
        weatherCode: current.weather_code ?? -1,
        observedAt: current.time ? withOffset(current.time, observedTimeZone) : null
      };
      return {
        section: { title: "天气与地点", body: `${name}：${weather.temperatureCelsius}°C，体感 ${weather.apparentTemperatureCelsius}°C。` },
        source: { kind: "weather", label: `Open-Meteo：${name}`, url: `https://open-meteo.com/en/docs#latitude=${match.latitude}&longitude=${match.longitude}`, provider: "open_meteo", retrievedAt: new Date().toISOString() },
        location,
        weather
      };
    } catch { return { section: { title: "天气与地点", body: `“${query}”的地点或天气暂时无法获取。` }, source: null, location: null, weather: null }; }
  }

  async weatherAtCoordinates(latitude: number, longitude: number): Promise<WeatherResult> {
    try {
      const reverseResponse = await this.fetcher(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&localityLanguage=zh`, { signal: AbortSignal.timeout(8_000) });
      const reverse = reverseResponse.ok ? await reverseResponse.json() as { countryName?: string; principalSubdivision?: string; city?: string; locality?: string } : {};
      const timezone = "Asia/Shanghai";
      const name = formatLocationName([reverse.locality, reverse.city, reverse.principalSubdivision, reverse.countryName]) || "本机位置（行政区暂不可用）";
      const response = await this.fetcher(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,apparent_temperature,weather_code&timezone=auto`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("weather_response_failed");
      const data = await response.json() as { timezone?: string; current?: { time?: string; temperature_2m?: number; apparent_temperature?: number; weather_code?: number } };
      const current = data.current;
      if (!current || current.temperature_2m === undefined) throw new Error("weather_payload_missing");
      const observedTimeZone = data.timezone ?? timezone;
      const weather = { temperatureCelsius: current.temperature_2m, apparentTemperatureCelsius: current.apparent_temperature ?? current.temperature_2m, weatherCode: current.weather_code ?? -1, observedAt: current.time ? withOffset(current.time, observedTimeZone) : null };
      return {
        section: { title: "天气与地点", body: `${name}：${weather.temperatureCelsius}°C，体感 ${weather.apparentTemperatureCelsius}°C。` },
        source: { kind: "weather", label: `Open-Meteo：${name}`, url: `https://open-meteo.com/en/docs#latitude=${latitude}&longitude=${longitude}`, provider: "open_meteo", retrievedAt: new Date().toISOString() },
        location: { name, latitude, longitude, timeZone: observedTimeZone },
        weather
      };
    } catch {
      return { section: { title: "天气与地点", body: "本机位置或天气暂时无法获取，请手动填写地点。" }, source: null, location: null, weather: null };
    }
  }

  async weeklyWeather(locationName: string | undefined, startDate: string, endDate: string): Promise<WeeklyWeatherResult> {
    const query = locationName?.trim();
    if (!query) return { source: null, location: null, days: [] };
    try {
      const geocodingResponse = await this.fetcher(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`, { signal: AbortSignal.timeout(8_000) });
      if (!geocodingResponse.ok) throw new Error("geocoding_response_failed");
      const geocoding = await geocodingResponse.json() as { results?: Array<{ name?: string; admin1?: string; country?: string; latitude?: number; longitude?: number; timezone?: string }> };
      const match = geocoding.results?.[0];
      if (!match?.name || match.latitude === undefined || match.longitude === undefined || !match.timezone) return { source: null, location: null, days: [] };
      const name = formatLocationName([match.name, match.admin1, match.country]);
      const location = { name, latitude: match.latitude, longitude: match.longitude, timeZone: match.timezone };
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${match.latitude}&longitude=${match.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${startDate}&end_date=${endDate}`;
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("weather_forecast_response_failed");
      const data = await response.json() as { daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: Array<number | null> } };
      const daily = data.daily;
      const days = (daily?.time ?? []).flatMap((localDate, index) => {
        const minimumCelsius = daily?.temperature_2m_min?.[index];
        const maximumCelsius = daily?.temperature_2m_max?.[index];
        if (minimumCelsius === undefined || maximumCelsius === undefined) return [];
        return [{
          localDate,
          minimumCelsius,
          maximumCelsius,
          precipitationProbabilityPercent: daily?.precipitation_probability_max?.[index] ?? null,
          weatherCode: daily?.weather_code?.[index] ?? -1
        }];
      });
      return { source: { kind: "weather", label: `Open-Meteo 七日预报：${name}`, provider: "open_meteo", retrievedAt: new Date().toISOString() }, location, days };
    } catch {
      return { source: null, location: null, days: [] };
    }
  }
}

function withOffset(localDateTime: string, timeZone: string): string | null {
  try {
    const date = new Date(`${localDateTime}Z`);
    if (Number.isNaN(date.getTime())) return null;
    const offsetName = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
    const offset = offsetName?.match(/GMT([+-]\d{2}:\d{2})/)?.[1];
    return offset ? `${localDateTime}${offset}` : `${localDateTime}Z`;
  } catch { return null; }
}

function formatLocationName(parts: Array<string | undefined | null>): string {
  const normalized = parts
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.trim().replace(/中华人民共和国/gu, "中国").replace(/中国大陆/gu, "中国"));
  return normalized.filter((part, index) => normalized.indexOf(part) === index).join("，");
}
