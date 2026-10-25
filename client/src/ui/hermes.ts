// Painel do Hermes no cliente (GET /api/hermes/painel; só com a fonte do Hermes ligada):
// - HermesHub: busca o painel (a cada 20 s; a cada 5 s com a janela aberta) e avisa a interface;
// - HermesQuotaCard: o cartão da conta Hermes na barra de uso (chamadas de IA e tokens do dia, limites/429);
// - HermesDialog: a janela "Servidor do Hermes" com as abas Servidor (CPU, RAM, disco, temperatura, ligado há),
//   Cotas de IA, Equipe (rotinas de cada perfil), Conversas (a resposta completa de cada rotina) e Mercado (a última
//   leitura do monitor do Kairo). Abre pelo botão da barra superior, pelo cartão de cotas e clicando no computador da
//   recepção, na TV do lounge (mercado) ou no quadro branco de uma sala do Hermes (equipe);
// - as janelas e os relógios do escritório dizem o tempo lá fora e a hora (aviso rápido).
import type { HermesMonitor, HermesPanel, HermesProfilePanel } from '../../../shared/hermes';
import { weatherKind } from '../../../shared/hermes';
import { tr } from '../../../shared/i18n';
import type { Notice } from '../../../shared/types';
import type { PropHit } from '../world/api';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setStyleVar, setText, setTitle } from './dom';
import { callsByModel, fetchHermesPanel, formatBytes, formatTokens, formatUptime, levelOf, modelLabel, profileOfAgent, quotaSummary, relTime, roomOf, roomOfProfile, systemLabel, systemLevel, teamTotals, type Level } from './hermes-model';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { createAccountChip, updateAccountChip } from './widgets';

const POLL_MS = 20_000;
const POLL_OPEN_MS = 5_000;

/** Computador em pixels (monitor + base), no traço dos outros ícones da barra. */
const SERVER_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M0 0h10v1H0zM0 1h1v5H0zM9 1h1v5H9zM0 6h10v1H0zM4 7h2v1H4zM2 8h6v1H2zM2 2h3v1H2zM2 4h5v1H2z"/></svg>';

export type HermesTab = 'servidor' | 'cotas' | 'equipe' | 'conversas' | 'mercado';
const TABS: Array<[HermesTab, string]> = [
  ['servidor', tr('Servidor')],
  ['cotas', tr('Cotas de IA')],
  ['equipe', tr('Equipe')],
  ['conversas', tr('Conversas')],
  ['mercado', tr('Mercado')],
];

/** Busca o painel e avisa quem quer saber. */
export class HermesHub {
  data: HermesPanel | null = null;
  /** A fonte do Hermes respondeu alguma vez (o recurso existe). */
  available = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fast = false;
  private listeners = new Set<() => void>();
  private loading = false;

  constructor(private readonly ctx: UiContext) {}

  on(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Há conta do Hermes no snapshot (sem ela, nem pergunta ao servidor). */
  private wanted(): boolean {
    const snap = this.ctx.store.snapshot;
    return !this.ctx.store.mock && !!snap?.accounts.some((a) => a.provider === 'hermes');
  }

  setFast(on: boolean): void {
    this.fast = on;
    this.schedule(on ? 0 : POLL_MS);
  }

  /** Chamado a cada render: começa o polling quando a conta do Hermes aparece. */
  tick(): void {
    if (!this.timer && !this.loading && this.wanted()) this.schedule(0);
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const data = await fetchHermesPanel();
      if (data) {
        this.data = data;
        this.available = true;
      }
    } finally {
      this.loading = false;
      for (const cb of this.listeners) cb();
      this.schedule(this.fast ? POLL_OPEN_MS : POLL_MS);
    }
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.wanted() && !this.fast) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (document.hidden && !this.fast) return this.schedule(POLL_MS);
      void this.refresh();
    }, ms);
  }
}

// ---------------------------------------------------------------- cartão de cotas

/** O cartão da conta Hermes na barra de uso: IA do dia em vez das janelas de 5 h/semana. */
export class HermesQuotaCard implements UiComponent {
  readonly el: HTMLElement;
  private chip = createAccountChip('lg');
  private name = h('span', { class: 'ui-usage-card__name', text: 'Hermes' });
  private sub = h('span', { class: 'ui-usage-card__email', text: tr('IA hoje') });
  private main = h('span', { class: 'ui-hq__main' });
  private state = h('span', { class: 'ui-hq__state' });

  constructor(
    private readonly ctx: UiContext,
    private readonly hub: HermesHub,
    private readonly open: (tab: HermesTab) => void,
  ) {
    this.el = h(
      'div',
      {
        class: 'ui-usage-card ui-hq',
        tabIndex: 0,
        role: 'button',
        hidden: true,
        attrs: { 'aria-label': tr('Hermes: cotas de IA de hoje (abre o painel)') },
        on: {
          click: () => this.open('cotas'),
          keydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              this.open('cotas');
            }
          },
        },
      },
      this.chip,
      h('div', { class: 'ui-usage-card__body' }, h('div', { class: 'ui-usage-card__head' }, this.name, this.sub), h('div', { class: 'ui-hq__row' }, this.main, this.state)),
    );
  }

  render(): void {
    const acc = this.ctx.store.snapshot?.accounts.find((a) => a.provider === 'hermes');
    const data = this.hub.data;
    setHidden(this.el, !acc || !data);
    if (!acc || !data) return;
    updateAccountChip(this.chip, acc, acc.id, 'hermes');
    setStyleVar(this.el, '--acc', acc.color);
    setText(this.name, acc.name);
    const now = this.ctx.now();
    const q = quotaSummary(data.quotas, now);
    setText(this.main, tr('{0} chamadas · {1} tokens', [q.calls.toLocaleString(), formatTokens(q.tokens)]));
    setText(this.state, q.line);
    this.state.dataset.level = q.level;
    const models = callsByModel(data.quotas)
      .slice(0, 6)
      .map((c) => `${modelLabel(c.model)} (${c.provider}): ${c.calls}${c.limits ? ` · ${tr('{0} limites', [c.limits])}` : ''}`);
    setTitle(this.el, [tr('Cotas de IA hoje (UTC)'), ...models, q.limitedAt ? tr('Último limite: {0}', [relTime(q.limitedAt, now)]) : '', tr('Clique para ver o painel')].filter(Boolean).join('\n'));
  }
}

// ---------------------------------------------------------------- janela

function bar(label: string, value: number | undefined, warn: number, crit: number, text?: string): HTMLElement {
  const lv = levelOf(value, warn, crit);
  const fill = h('span', { class: 'ui-hp-bar__fill' });
  const el = h('div', { class: `ui-hp-bar${lv ? ` is-${lv}` : ''}` }, h('span', { class: 'ui-hp-bar__label', text: label }), h('span', { class: 'ui-hp-bar__track' }, fill), h('b', { class: 'ui-hp-bar__value', text: value === undefined ? '—' : (text ?? `${value}%`) }));
  setStyleVar(fill, '--pct', String(Math.max(0, Math.min(100, value ?? 0))));
  return el;
}

function kv(rows: Array<[string, string | Node]>): HTMLElement {
  const dl = h('dl', { class: 'ui-kv' });
  for (const [k, v] of rows) dl.append(h('dt', { text: k }), h('dd', {}, v));
  return dl;
}

function badge(text: string, level?: Level | 'info'): HTMLElement {
  return h('span', { class: `ui-hp-badge${level ? ` is-${level}` : ''}`, text });
}

function link(href: string, text: string): HTMLElement {
  return h('a', { class: 'ui-link-btn', text, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } });
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export class HermesDialog implements UiComponent {
  readonly el: HTMLDialogElement;
  private tab: HermesTab = 'servidor';
  private tabs = new Map<HermesTab, HTMLButtonElement>();
  private body: HTMLElement;
  private title: HTMLElement;
  private clock: HTMLElement;
  private weather: HTMLElement;
  private status: HTMLElement;
  private renderedAt = 0;
  private renderedTab: HermesTab | null = null;
  /** Perfil escolhido em Equipe/Conversas/Mercado ('' = todos). */
  private profile = '';
  private opener: HTMLElement | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly hub: HermesHub,
  ) {
    this.title = h('h2', { text: tr('Servidor do Hermes'), attrs: { id: 'ui-hp-title' } });
    this.clock = h('span', { class: 'ui-hp__clock' });
    this.weather = h('span', { class: 'ui-hp__weather' });
    const seg = h('div', { class: 'ui-seg ui-hp__tabs', role: 'tablist', attrs: { 'aria-label': tr('Seções') } });
    for (const [id, label] of TABS) {
      const b = h('button', { class: 'ui-seg__opt', type: 'button', role: 'tab', text: label, on: { click: () => this.show(id) } });
      this.tabs.set(id, b);
      seg.append(b);
    }
    const close = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.status = h('p', { class: 'ui-hp__status' });
    this.body = h('div', { class: 'ui-hp__content', role: 'tabpanel' });
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-hp', attrs: { 'aria-labelledby': 'ui-hp-title' } },
      h('div', { class: 'ui-dialog__head ui-hp__head' }, h('div', { class: 'ui-hp__title' }, this.title, this.clock, this.weather), seg, close),
      h('div', { class: 'ui-hp__body' }, this.status, this.body),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => {
      this.hub.setFast(false);
      if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
      this.opener = null;
    });
    hub.on(() => this.el.open && this.render(true));
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  open(tab: HermesTab = this.tab, profile?: string): void {
    this.tab = tab;
    if (profile !== undefined) this.profile = profile;
    if (!this.el.open) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.el.showModal();
      this.hub.setFast(true);
    }
    this.render(true);
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  private show(tab: HermesTab): void {
    this.tab = tab;
    this.render(true);
  }

  render(force = false): void {
    if (!this.el.open) return;
    const now = this.ctx.now();
    setText(this.clock, new Date(now).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
    const d = this.hub.data;
    for (const [id, b] of this.tabs) setAttr(b, 'aria-checked', String(id === this.tab));
    for (const [id, b] of this.tabs) setAttr(b, 'aria-selected', String(id === this.tab));
    if (!d) {
      setText(this.status, this.hub.available ? '' : tr('Carregando o painel do Hermes…'));
      return;
    }
    setText(this.title, d.system.host ? tr('Servidor do Hermes · {0}', [d.system.host]) : tr('Servidor do Hermes'));
    const w = d.weather;
    setText(this.weather, w ? `${{ rain: '🌧️', cloud: '☁️', night: '🌙', sun: '☀️' }[weatherKind(w)]} ${Math.round(w.tempC)} °C${w.place ? ` · ${w.place}` : ''}` : '');
    setText(this.status, tr('Atualizado {0}', [relTime(d.generatedAt, Math.max(now, d.generatedAt))]));
    // Só refaz o conteúdo quando os dados ou a aba mudam (a rolagem e a seleção de texto ficam).
    if (!force && d.generatedAt === this.renderedAt && this.tab === this.renderedTab) return;
    this.renderedAt = d.generatedAt;
    const scroll = this.tab === this.renderedTab ? this.body.parentElement!.scrollTop : 0;
    this.renderedTab = this.tab;
    this.body.replaceChildren(this.content(d, now));
    this.body.parentElement!.scrollTop = scroll;
  }

  private content(d: HermesPanel, now: number): Node {
    switch (this.tab) {
      case 'servidor':
        return this.server(d, now);
      case 'cotas':
        return this.quotas(d, now);
      case 'equipe':
        return this.team(d, now);
      case 'conversas':
        return this.talks(d);
      case 'mercado':
        return this.market(d, now);
    }
  }

  private goAgent(id: string | undefined, terminal = false): void {
    if (!id || !this.ctx.agent(id)) return;
    this.close();
    this.ctx.select({ type: 'agent', id }, { focus: true });
    if (terminal) this.ctx.terminals?.open(id);
  }

  private agentButton(id: string | undefined, label: string, terminal = false): HTMLElement | null {
    if (!id || !this.ctx.agent(id)) return null;
    return h('button', { class: 'ui-link-btn', type: 'button', text: label, on: { click: () => this.goAgent(id, terminal) } });
  }

  private profilePicker(d: HermesPanel): HTMLElement | null {
    if (d.profiles.length < 2) return null;
    const sel = h('select', { class: 'ui-day__select', attrs: { 'aria-label': tr('Perfil') }, on: { change: () => ((this.profile = sel.value), this.render(true)) } });
    sel.append(h('option', { text: tr('Todos os perfis'), attrs: { value: '' } }));
    for (const p of d.profiles) sel.append(h('option', { text: roomOf(p), attrs: { value: p.name } }));
    sel.value = this.profile;
    return sel;
  }

  private profiles(d: HermesPanel): HermesProfilePanel[] {
    return this.profile ? d.profiles.filter((p) => p.name === this.profile) : d.profiles;
  }

  // ---------------------------------------------------------------- abas

  private server(d: HermesPanel, now: number): Node {
    const s = d.system;
    const lv = systemLevel(s);
    const t = teamTotals(d);
    const agents = this.ctx.store.snapshot?.agents.filter((a) => a.provider === 'hermes') ?? [];
    const on = agents.filter((a) => a.status !== 'offline').length;
    return h(
      'div',
      { class: 'ui-hp__section' },
      h('p', { class: 'ui-hp__lead' }, badge(systemLabel(lv), lv), ' ', tr('Ligado há {0}.', [formatUptime(s.uptimeSec)])),
      bar(tr('CPU'), s.cpuPct, 70, 90),
      bar(tr('RAM'), s.memPct, 75, 90, s.memPct !== undefined ? `${s.memPct}% · ${formatBytes(s.memUsed)} / ${formatBytes(s.memTotal)}` : undefined),
      bar(tr('Disco'), s.diskPct, 80, 90, s.diskPct !== undefined ? `${s.diskPct}% · ${tr('{0} livres', [formatBytes(s.diskFree)])}` : undefined),
      bar(tr('Temp.'), s.tempC, 75, 85, s.tempC !== undefined ? `${s.tempC} °C` : undefined),
      kv([
        [tr('Carga (1/5/15 min)'), s.load ? s.load.join(' · ') : '—'],
        [tr('Núcleos'), s.cpus ? String(s.cpus) : '—'],
        [tr('Agentes ligados'), tr('{0} de {1}', [on, agents.length])],
        [tr('Rotinas'), t.running ? tr('{0} ({1} rodando agora)', [t.jobs, t.running]) : String(t.jobs)],
        [tr('Tokens hoje'), formatTokens(t.tokens)],
        [tr('Hora'), new Date(now).toLocaleString()],
      ]),
      h('p', { class: 'ui-hp__note', text: tr('No container do Atrio, CPU, carga e memória são as do computador; o disco é o da pasta do Hermes. Sem a temperatura, o computador não expõe /sys/class/thermal ao container.') }),
      d.links?.beszel ? h('p', {}, link(d.links.beszel, tr('Abrir o Beszel ↗'))) : null,
    );
  }

  private quotas(d: HermesPanel, now: number): Node {
    const q = d.quotas;
    const sum = quotaSummary(q, now);
    const wrap = h('div', { class: 'ui-hp__section' });
    wrap.append(
      h('p', { class: 'ui-hp__lead' }, badge(sum.line, sum.level), ' ', tr('{0} chamadas e {1} tokens hoje ({2} UTC); {3} rodadas de rotina.', [sum.calls.toLocaleString(), formatTokens(sum.tokens), q.day, q.runsToday])),
      h('p', {
        class: 'ui-hp__note',
        text: tr('O Hermes usa o combo "kairo" do OmniRoute, que distribui entre os provedores e troca quando um esgota ou falha. Os outros modelos abaixo são chamados direto (reserva, títulos, aprovações).'),
      }),
    );
    if (d.links?.omniroute) wrap.append(h('p', {}, link(d.links.omniroute, tr('Abrir o OmniRoute ↗'))));
    const calls = callsByModel(q);
    wrap.append(h('h3', { text: q.calls.length ? tr('Chamadas por modelo (logs/agent.log)') : tr('Chamadas por modelo (state.db)') }));
    if (!calls.length) wrap.append(h('p', { class: 'ui-hp__empty', text: tr('Nenhuma chamada hoje.') }));
    else {
      const table = h('table', { class: 'ui-hp__table' }, h('tr', {}, ...[tr('Modelo'), tr('Provedor'), tr('Chamadas'), tr('Limites')].map((t) => h('th', { text: t }))));
      for (const c of calls) {
        table.append(
          h(
            'tr',
            {},
            h('td', { text: modelLabel(c.model), title: c.model }),
            h('td', { text: c.provider }),
            h('td', { text: c.calls.toLocaleString() }),
            h('td', {}, c.limits ? badge(tr('{0} · último {1}', [c.limits, c.limitedAt ? relTime(c.limitedAt, now) : '?']), now - (c.limitedAt ?? 0) < 3_600_000 ? 'crit' : 'warn') : badge(tr('livre'), 'ok')),
          ),
        );
      }
      wrap.append(table);
    }
    if (q.usage.length) {
      wrap.append(h('h3', { text: tr('Uso por modelo e provedor (state.db)') }));
      const table = h('table', { class: 'ui-hp__table' }, h('tr', {}, ...[tr('Perfil'), tr('Modelo'), tr('Provedor'), tr('Para'), tr('Chamadas'), tr('Tokens')].map((t) => h('th', { text: t }))));
      for (const u of q.usage) {
        table.append(
          h(
            'tr',
            {},
            h('td', { text: roomOfProfile(d, u.profile) }),
            h('td', { text: modelLabel(u.model), title: u.model }),
            h('td', { text: u.provider }),
            h('td', { text: u.task || tr('conversa') }),
            h('td', { text: u.calls.toLocaleString() }),
            h('td', { text: `${formatTokens(u.tokensIn)} / ${formatTokens(u.tokensOut)}` }),
          ),
        );
      }
      wrap.append(table);
    }
    wrap.append(h('h3', { text: tr('Limites e 429 de hoje') }));
    if (!q.limits.length) wrap.append(h('p', { class: 'ui-hp__empty', text: q.logFound ? tr('Nenhum limite hoje.') : tr('Nenhum limite visto (sem logs/agent.log; só os erros das rotinas).') }));
    else {
      const ul = h('ul', { class: 'ui-hp__list' });
      for (const l of q.limits.slice(0, 20)) ul.append(h('li', {}, h('span', { class: 'ui-hp__when', text: fmtTime(l.at) }), ' ', h('b', { text: [l.profile ? roomOfProfile(d, l.profile) : '', l.model, l.provider].filter(Boolean).join(' · ') }), h('div', { class: 'ui-hp__mono', text: l.text })));
      wrap.append(ul);
    }
    return wrap;
  }

  private team(d: HermesPanel, now: number): Node {
    const wrap = h('div', { class: 'ui-hp__section' });
    const pick = this.profilePicker(d);
    if (pick) wrap.append(pick);
    for (const p of this.profiles(d)) {
      const agent = this.ctx.agent(p.agentId);
      const card = h(
        'section',
        { class: 'ui-hp__card' },
        h(
          'h3',
          {},
          agent ? badge(agent.status === 'working' ? tr('trabalhando') : agent.status === 'offline' ? tr('desligado') : agent.status === 'waiting' ? tr('esperando você') : tr('ocioso'), agent.status === 'working' ? 'ok' : agent.status === 'offline' ? 'crit' : 'info') : null,
          ' ',
          `${agent?.name ?? roomOf(p)} · ${roomOf(p) === p.name ? tr('perfil {0}', [p.name]) : tr('sala {0} (perfil {1})', [roomOf(p), p.name])}`,
        ),
        p.description ? h('p', { class: 'ui-hp__note', text: p.description }) : null,
        h('p', { class: 'ui-hp__note', text: tr('{0} tokens hoje · {1} rodadas', [formatTokens(p.tokensToday), p.runsToday]) }),
        h('p', { class: 'ui-hp__actions' }, this.agentButton(p.agentId, tr('Ver no escritório')), this.agentButton(p.agentId, tr('Abrir o terminal'), true)),
      );
      if (!p.jobs.length) card.append(h('p', { class: 'ui-hp__empty', text: tr('Nenhuma rotina agendada.') }));
      for (const j of p.jobs) {
        const st = j.running ? badge(tr('rodando agora'), 'ok') : !j.enabled ? badge(tr('pausada'), 'warn') : j.lastStatus && !/^(ok|success|completed|no_change|silent)$/i.test(j.lastStatus) ? badge(j.lastStatus, 'crit') : badge(j.lastStatus ?? tr('agendada'), 'info');
        const line = [j.schedule, j.monitor ? tr('só acorda se algo mudar') : '', j.running ? '' : tr('próxima {0}', [relTime(j.nextRunAt, now)]), tr('última {0}', [relTime(j.lastRunAt, now)])].filter(Boolean).join(' · ');
        card.append(
          h(
            'div',
            { class: 'ui-hp__job' },
            h('div', {}, h('b', { text: j.name }), ' ', st, ' ', this.agentButton(j.vigiaId, tr('Ver o Vigia'))),
            h('div', { class: 'ui-hp__note', text: line }),
            j.lastError ? h('div', { class: 'ui-hp__mono is-crit', text: j.lastError }) : null,
          ),
        );
      }
      wrap.append(card);
    }
    return wrap;
  }

  private talks(d: HermesPanel): Node {
    const wrap = h('div', { class: 'ui-hp__section' });
    const pick = this.profilePicker(d);
    if (pick) wrap.append(pick);
    const all = this.profiles(d)
      .flatMap((p) => p.outputs.map((o) => ({ o, p })))
      .sort((a, b) => b.o.at - a.o.at);
    const quiet = all.filter((x) => x.o.kind !== 'agent');
    if (quiet.length) {
      const last = quiet[0];
      wrap.append(h('p', { class: 'ui-hp__note', text: tr('{0} das últimas {1} passadas sem novidade (a última {2}).', [quiet.length, all.length, relTime(last.o.at, this.ctx.now())]) }));
    }
    const said = all.filter((x) => x.o.kind === 'agent');
    if (!said.length) wrap.append(h('p', { class: 'ui-hp__empty', text: tr('Ainda não houve rodada com o modelo.') }));
    for (const { o, p } of said) {
      const body = h('div', { class: 'ui-hp__md' });
      if (o.text) body.append(renderMarkdown(o.text));
      else body.append(h('span', { class: 'ui-hp__empty', text: tr('A resposta completa abre pelo terminal (acesso local).') }));
      wrap.append(
        h(
          'article',
          { class: 'ui-hp__talk' },
          h('div', { class: 'ui-hp__talk-head' }, h('span', { class: 'ui-hp__when', text: fmtTime(o.at) }), ' ', h('b', { text: `${this.ctx.agent(p.agentId)?.name ?? roomOf(p)} · ${o.jobName}` }), ' ', this.agentButton(p.agentId, tr('Abrir no terminal'), true)),
          body,
        ),
      );
    }
    return wrap;
  }

  private monitorView(m: HermesMonitor, owner: HermesProfilePanel, now: number): HTMLElement {
    const k = m.market;
    const card = h(
      'section',
      { class: 'ui-hp__card' },
      h('h3', {}, tr('{0} · {1}', [roomOf(owner), m.jobName]), ' ', h('span', { class: 'ui-hp__when', text: tr('leitura {0}', [relTime(m.at, now)]) }), ' ', this.agentButton(m.agentId, tr('Ver o Vigia'))),
    );
    if (k && !k.online) card.append(h('p', {}, badge(tr('Kairo fora do ar'), 'crit'), ' ', tr('o agente espera ele voltar.')));
    if (k?.online) {
      const open = k.instances.filter((i) => i.position);
      card.append(
        kv([
          [tr('Mandato'), k.active === false ? tr('desligado') : tr('ligado')],
          [tr('Disponível'), k.available ? `${k.available} USDT` : '—'],
          [tr('Em aberto'), k.open ? `${k.open} USDT` : '—'],
          [tr('Perda'), k.loss ? `${k.loss} USDT` : '—'],
          [tr('Posições'), tr('{0} de {1}', [open.length, k.instances.length])],
        ]),
      );
      if (k.instances.length) {
        const t = h('table', { class: 'ui-hp__table' }, h('tr', {}, ...[tr('Instância'), tr('Tempo'), tr('Status'), tr('Posição'), tr('Resultado')].map((x) => h('th', { text: x }))));
        for (const i of k.instances) {
          const r = Number.parseFloat(i.result ?? '');
          t.append(
            h(
              'tr',
              {},
              h('td', { text: i.pair }),
              h('td', { text: i.interval ?? '' }),
              h('td', { text: i.status ?? '' }),
              h('td', {}, i.position ? badge(tr('aberta'), 'ok') : tr('esperando entrada')),
              h('td', {}, i.result ? badge(`${i.result}%`, r > 0 ? 'ok' : r < 0 ? 'crit' : 'info') : '—'),
            ),
          );
        }
        card.append(t);
      }
      if (k.radar.length) card.append(h('h4', { text: tr('Radar') }), h('p', {}, ...k.radar.slice(0, 8).flatMap((r) => [badge(`${r.pair}${r.score ? ` ${r.score}` : ''}${r.interval ? ` · ${r.interval}` : ''}`, 'info'), ' '])));
      if (k.events.length) card.append(h('h4', { text: tr('Eventos recentes') }), h('p', { class: 'ui-hp__note', text: k.events.map((e) => `#${e.id} ${e.type}`).join(' · ') }));
      if (k.warnings.length) card.append(h('h4', { text: tr('Avisos') }), h('ul', { class: 'ui-hp__list' }, ...k.warnings.map((w) => h('li', { text: w }))));
    }
    card.append(h('details', {}, h('summary', { text: tr('Leitura completa do monitor') }), h('pre', { class: 'ui-hp__pre', text: m.lines.join('\n') || tr('(leitura vazia)') })));
    return card;
  }

  private market(d: HermesPanel, now: number): Node {
    const wrap = h('div', { class: 'ui-hp__section' });
    const list = this.profiles(d).flatMap((p) => p.monitors.map((m) => this.monitorView(m, p, now)));
    if (!list.length) wrap.append(h('p', { class: 'ui-hp__empty', text: tr('Nenhuma rotina com monitor (monitor_script) ainda leu nada.') }));
    wrap.append(...list);
    return wrap;
  }
}

// ---------------------------------------------------------------- montagem

/** Liga o painel do Hermes na interface: botão da barra, cartão de cotas, janela e os móveis clicáveis. */
export class HermesUi implements UiComponent {
  readonly hub: HermesHub;
  readonly dialog: HermesDialog;
  readonly card: HermesQuotaCard;
  readonly button: HTMLButtonElement;

  constructor(
    private readonly ctx: UiContext,
    private readonly toast: (n: Notice) => void,
  ) {
    this.hub = new HermesHub(ctx);
    this.dialog = new HermesDialog(ctx, this.hub);
    this.card = new HermesQuotaCard(ctx, this.hub, (tab) => this.dialog.open(tab));
    this.button = iconButton(SERVER_ICON, tr('Servidor do Hermes: computador, cotas de IA, equipe, conversas e mercado'), () => (this.dialog.isOpen ? this.dialog.close() : this.dialog.open()));
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.hidden = true;
    this.hub.on(() => ctx.invalidate());
    ctx.world.setPropHandler?.({ wants: (p) => this.wants(p), click: (p) => this.click(p) });
  }

  /** O painel (e a agenda dos agentes) do agente do Hermes: abre na aba Equipe no perfil dele. */
  openFor(agentId: string, tab: HermesTab = 'equipe'): void {
    const p = profileOfAgent(this.hub.data, agentId);
    this.dialog.open(tab, p?.name ?? '');
  }

  private roomProfile(areaId: string): HermesProfilePanel | undefined {
    const agents = this.ctx.store.snapshot?.agents ?? [];
    const ids = new Set(agents.filter((a) => a.roomId === areaId).map((a) => a.id));
    return this.hub.data?.profiles.find((p) => ids.has(p.agentId));
  }

  private wants(p: PropHit): boolean {
    if (!this.hub.available) return p.kind === 'clock';
    if (p.kind === 'whiteboard') return !!this.roomProfile(p.areaId);
    if (p.kind === 'tv') return !!this.hub.data?.profiles.some((x) => x.monitors.length);
    return true;
  }

  private click(p: PropHit): boolean {
    const now = this.ctx.now();
    const note = (text: string) => this.toast({ id: `hp-${p.kind}-${now}`, level: 'info', text, at: now });
    switch (p.kind) {
      case 'server':
        this.dialog.open('servidor');
        return true;
      case 'tv':
        this.dialog.open('mercado', '');
        return true;
      case 'whiteboard': {
        const prof = this.roomProfile(p.areaId);
        if (!prof) return false;
        this.dialog.open('equipe', prof.name);
        return true;
      }
      case 'window': {
        const w = this.hub.data?.weather;
        if (!w) {
          note(tr('Sem dados do tempo agora.'));
          return true;
        }
        const kind = { rain: tr('chovendo'), cloud: tr('nublado'), night: tr('céu limpo, noite'), sun: tr('sol') }[weatherKind(w)];
        note(tr('Lá fora: {0} °C, {1}{2}.', [Math.round(w.tempC), kind, w.place ? tr(' em {0}', [w.place]) : '']));
        return true;
      }
      case 'clock':
        note(tr('São {0}.', [new Date(now).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })]));
        return true;
    }
  }

  render(): void {
    this.hub.tick();
    this.button.hidden = !this.hub.available;
    this.card.render();
    this.dialog.render();
  }
}
