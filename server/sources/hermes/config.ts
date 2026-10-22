// Variáveis de ambiente do painel do Hermes (GET /api/hermes/painel):
// - HABBLAUD_CLIMA=0 desliga o tempo lá fora; HABBLAUD_CLIMA_LAT, HABBLAUD_CLIMA_LON e HABBLAUD_CLIMA_LOCAL escolhem
//   o lugar (padrão: São Paulo). A consulta vai ao open-meteo (sem chave), no máximo a cada 10 min;
// - HABBLAUD_OMNIROUTE_URL e HABBLAUD_BESZEL_URL: links "Abrir o OmniRoute" (cotas) e "Abrir o Beszel" (servidor).
import type { HermesPanel } from '../../../shared/hermes';
import type { WeatherOptions } from './panel';

const COORD = /^-?\d{1,3}(?:\.\d{1,6})?$/;

export function hermesWeather(env: NodeJS.ProcessEnv): WeatherOptions | false {
  const flag = env.HABBLAUD_CLIMA?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  const lat = env.HABBLAUD_CLIMA_LAT?.trim() || '-23.55';
  const lon = env.HABBLAUD_CLIMA_LON?.trim() || '-46.63';
  if (!COORD.test(lat) || !COORD.test(lon)) return false;
  const place = env.HABBLAUD_CLIMA_LOCAL?.trim().slice(0, 60) || (env.HABBLAUD_CLIMA_LAT ? undefined : 'São Paulo');
  return { lat, lon, ...(place ? { place } : {}) };
}

function url(v: string | undefined): string | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function hermesLinks(env: NodeJS.ProcessEnv): HermesPanel['links'] {
  const omniroute = url(env.HABBLAUD_OMNIROUTE_URL);
  const beszel = url(env.HABBLAUD_BESZEL_URL);
  if (!omniroute && !beszel) return undefined;
  return { ...(omniroute ? { omniroute } : {}), ...(beszel ? { beszel } : {}) };
}
