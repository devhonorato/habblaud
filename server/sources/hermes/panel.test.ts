// Leitura do computador e do tempo lá fora do painel do Hermes (arquivos /proc e /sys sintéticos).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { hermesLinks, hermesWeather } from './config';
import { readAgentLogs, readTemperature, SystemReader, WeatherService } from './panel';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function fakeOs(idle: number, busy: number) {
  return {
    cpus: () => [{ model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }, { model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }],
    loadavg: () => [0, 0, 0],
    totalmem: () => 8e9,
    freemem: () => 2e9,
    uptime: () => 100,
    hostname: () => 'maiden',
  };
}

describe('painel do Hermes: computador', () => {
  it('lê /proc (carga, memória, ligado há), /sys (temperatura) e o disco da pasta; CPU por amostra', () => {
    const tmp = tempDir('habblaud-hermes-sys-');
    cleanups.push(tmp.cleanup);
    const proc = join(tmp.dir, 'proc');
    const sys = join(tmp.dir, 'sys');
    mkdirSync(proc, { recursive: true });
    writeFileSync(join(proc, 'loadavg'), '1.00 0.50 0.25 1/100 999\n');
    writeFileSync(join(proc, 'meminfo'), 'MemTotal:       16000000 kB\nMemFree:  1000 kB\nMemAvailable:    4000000 kB\n');
    writeFileSync(join(proc, 'uptime'), '7200.5 100.0\n');
    for (const [z, v] of [
      ['thermal_zone0', '45000'],
      ['thermal_zone1', '61500'],
      ['thermal_zone2', '-1000'],
    ]) {
      mkdirSync(join(sys, 'class', 'thermal', z), { recursive: true });
      writeFileSync(join(sys, 'class', 'thermal', z, 'temp'), v);
    }
    let os = fakeOs(100, 100);
    const r = new SystemReader({ dir: tmp.dir, procRoot: proc, sysRoot: sys, os: { ...os, cpus: () => os.cpus() }, statfs: () => ({ blocks: 1000, bavail: 250, bsize: 4096 }) });
    const first = r.read();
    expect(first).toMatchObject({ host: 'maiden', cpus: 2, load: [1, 0.5, 0.25], cpuPct: 50, memTotal: 16000000 * 1024, memPct: 75, diskPct: 75, tempC: 62, uptimeSec: 7201 });
    os = fakeOs(190, 110); // +90 ocioso, +10 ocupado por núcleo
    expect(r.read().cpuPct).toBe(10);
    expect(readTemperature(join(tmp.dir, 'nada'))).toBeUndefined();
  });

  it('agent.log ausente: found false, sem chamadas', () => {
    expect(readAgentLogs('/nao/existe', ['crypto'], '2026-10-22')).toEqual({ calls: [], limits: [], found: false });
  });
});

describe('painel do Hermes: tempo e links', () => {
  it('WeatherService guarda o último valor e não lança sem rede', async () => {
    let fail = false;
    const fetchFake = (async () => {
      if (fail) throw new Error('sem rede');
      return { json: async () => ({ current: { temperature_2m: 24.3, weather_code: 61, is_day: 1 } }) };
    }) as unknown as typeof fetch;
    let now = 0;
    const w = new WeatherService({ lat: '-23.5', lon: '-46.6', place: 'SP', fetch: fetchFake, now: () => now });
    await w.refresh();
    expect(w.current()).toEqual({ tempC: 24.3, code: 61, day: true, place: 'SP' });
    fail = true;
    now = 3_600_000;
    await w.refresh();
    expect(w.current()?.tempC).toBe(24.3);
  });

  it('variáveis de ambiente', () => {
    expect(hermesWeather({ HABBLAUD_CLIMA: '0' })).toBe(false);
    expect(hermesWeather({})).toEqual({ lat: '-23.55', lon: '-46.63', place: 'São Paulo' });
    expect(hermesWeather({ HABBLAUD_CLIMA_LAT: 'x' })).toBe(false);
    expect(hermesLinks({ HABBLAUD_OMNIROUTE_URL: 'https://r.example:10000/dashboard', HABBLAUD_BESZEL_URL: 'javascript:alert(1)' })).toEqual({ omniroute: 'https://r.example:10000/dashboard' });
    expect(hermesLinks({})).toBeUndefined();
  });
});
