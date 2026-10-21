// Entrevistas (documento 13): minha escala, agenda, disponibilidade e a página de cada sessão com o registro.
//   #/entrevistas[/minha-escala|/agenda|/disponibilidade]   Todos que fazem entrevista (allowlist.avaliar) e a Direção.
//   #/entrevistas/sessao/<id>                               Participantes da sessão e a Direção.
// A Direção monta a escala em escalas-admin.js (#/entrevistas/gestao). Horário sempre de Brasília.
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { copyButton } from '../components.js';
import { attachFormDraft } from '../draft.js';
import {
  ESCALA_ERRORS, ESC_LIMITS, ESC_PARTICIPANT_ROLES, ESC_ROLE_LABELS, ESC_SESSION_STATUS_LABELS, ESC_HISTORY_LABELS,
  ESC_WEEKDAYS, ESC_WEEKDAYS_SHORT, brasiliaToday, cellKey, formatDateBr, groupParticipants, horarioLabel, interviewMessage,
  isSessionParticipant, sessionStart, slotsByCell, sortDays, sortHorarios, validateRegistro, weekdayOf,
} from '../../core/escalas.js';
import { formField, showFieldErrors } from './gabarito.js';
import { singlePrintPicker } from '../print-drop.js';
import { renderMessage } from './message.js';
import { runDestructive } from '../destructive.js';

/**
 * Documento 14 · cancelar sessão (escalas.cancelar; escalas.gerenciar no banco sem o SQL 25). Pede motivo, grava na auditoria
 * e avisa no privado os outros escalados. Quem chama decide se mostra o botão.
 */
export const canCancelSession = (app) => (app.feature('apagar') ? app.can('escalas.cancelar') : app.can('escalas.gerenciar'));
export function cancelSessionFlow(app, s, onDone) {
  return runDestructive(app, 'session', {
    detail: h('p', {}, h('strong', {}, `${formatDateBr(s.data_entrevista)} às ${horarioLabel(s.horario)}`)),
    call: (reason) => app.adapter.cancelInterviewSession(s.id, reason),
    okMessage: (res) => {
      const { dm, discord_error: failed } = res.data;
      if (failed) return `Sessão cancelada. O aviso no privado não foi enviado: ${failed}`;
      if (dm?.failed?.length) return `Sessão cancelada. ${dm.sent} avisada(s) no privado; ${dm.failed.length} sem privado.`;
      return dm?.sent ? `Sessão cancelada. ${dm.sent} pessoa(s) avisada(s) no privado.` : 'Sessão cancelada.';
    },
    onDone,
  });
}

/**
 * Limpar a agenda inteira (SQL 26, feature "limpar_agenda"; escalas.cancelar): apaga as sessões agendadas que ainda não começaram,
 * em Minha escala e na Agenda, e (opcional) encerra a escala publicada. Pede CONFIRMAR e motivo; auditoria no banco.
 */
export const canClearAgenda = (app) => app.feature('apagar') && app.feature('limpar_agenda') && app.can('escalas.cancelar');
export async function clearAgendaFlow(app, onDone) {
  const [sessions, escala] = await Promise.all([app.adapter.listInterviewSessions({ from: '2000-01-01', to: '2100-12-31' }), app.adapter.getEscala()]);
  if (sessions.error) { app.reportError(sessions.error, 'Não foi possível conferir a agenda.'); return false; }
  const now = Date.now();
  const doomed = sessions.data.filter((s) => s.status === 'agendada' && !s.tem_registro && sessionStart(s.data_entrevista, s.horario).getTime() >= now);
  const published = escala.data?.escala?.status === 'publicada';
  if (!doomed.length && !published) { toast('Não há sessões agendadas para limpar.'); return false; }
  const close = h('input', { type: 'checkbox', id: 'esc-clear-close', checked: published, disabled: !published });
  const detail = h('div', { class: 'esc-clear-detail' },
    h('p', {}, h('strong', {}, `${doomed.length} sessão(ões) agendada(s)`), ' serão apagadas.'),
    published && h('label', { class: 'esc-check' }, close, ' Encerrar também a escala publicada (você poderá abrir outra)'));
  return runDestructive(app, 'agenda', {
    detail,
    call: (reason) => app.adapter.clearInterviewAgenda({ reason, closeEscala: close.checked }),
    okMessage: (res) => {
      const { sessoes_apagadas: n, escalas_encerradas: e } = res.data;
      return `✓ Agenda limpa: ${n} sessão(ões) apagada(s)${e ? ' e escala encerrada' : ''}.`;
    },
    onDone,
  });
}
/** Botão "Limpar agenda" (mesmo visual nas telas das entrevistas). */
export const clearAgendaButton = (app, onDone, { small = true } = {}) => canClearAgenda(app) && h('button', {
  type: 'button', class: `btn${small ? ' btn--sm' : ''} btn--danger-outline`, id: 'esc-clear-agenda', 'data-requires-online': '',
  title: 'Apaga todas as sessões agendadas que ainda não começaram', onclick: () => clearAgendaFlow(app, onDone),
}, icon('calendar-off'), 'Limpar agenda');

/* ---------------------------------------------------------------------------
 * Partes compartilhadas (a Gestão da Direção reaproveita)
 * ------------------------------------------------------------------------- */
export const escalaAllowed = (app) => app.feature('escalas') && (app.can('allowlist.avaliar') || app.can('escalas.gerenciar'));

export function denyEscalas(app) {
  renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não abre a escala das entrevistas.' });
  return null;
}

/** Abas de cima (links). `active` = chave da aba. */
export function escalaTabs(app, active) {
  const items = [
    ['minha-escala', 'Minha escala', '#/entrevistas'],
    ['agenda', 'Agenda', '#/entrevistas/agenda'],
    ['disponibilidade', 'Disponibilidade', '#/entrevistas/disponibilidade'],
    ...(app.can('escalas.gerenciar') ? [['gestao', 'Gestão da escala', '#/entrevistas/gestao']] : []),
  ];
  return h('nav', { class: 'esc-tabs', 'aria-label': 'Seções das entrevistas' },
    items.map(([key, label, href]) => h('a', { class: 'esc-tab', href, 'aria-current': active === key ? 'page' : null, dataset: { tab: key } }, label)));
}

const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (date) => addDays(date, -((weekdayOf(date) + 6) % 7));
const dayLabel = (date) => `${ESC_WEEKDAYS[weekdayOf(date)]}, ${formatDateBr(date).slice(0, 5)}`;

export const statusBadge = (view) => h('span', { class: `badge esc-status esc-status--${view}`, dataset: { status: view } }, ESC_SESSION_STATUS_LABELS[view] ?? view);

const names = (list) => list.map((p) => p.display_name || p.discord_id).join(', ');

/** Resumo de quem está na sessão: "Entrevistadores: A, B · Suportes: C". */
function peopleLine(participants) {
  const g = groupParticipants(participants);
  const parts = [['entrevistador', 'Entrevistadores'], ['suporte', 'Suportes'], ['acompanhante', 'Acompanhando']]
    .filter(([k]) => g[k].length).map(([k, label]) => `${label}: ${names(g[k])}`);
  return parts.length ? parts.join(' · ') : 'Ninguém escalado';
}

async function loadBase(app) {
  const [cfg, names2] = await Promise.all([app.adapter.getEscalaConfig(), app.adapter.listStaffNames()]);
  return { cfg, names: names2 };
}

/* ---------------------------------------------------------------------------
 * #/entrevistas · Minha escala, Agenda e Disponibilidade
 * ------------------------------------------------------------------------- */
export function renderEscalas(app, tabKey) {
  if (!escalaAllowed(app)) return denyEscalas(app);
  const tab = ['agenda', 'disponibilidade'].includes(tabKey) ? tabKey : 'minha-escala';
  const me = app.state.staff.discord_id;
  let alive = true;
  let config = null;
  let timer = null;
  const body = h('div', { class: 'esc-body' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  app.els.main.replaceChildren(h('div', { class: 'main-inner esc-page' },
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Entrevistas'),
      h('p', { class: 'page-sub' }, 'Escala, agenda e registro das entrevistas de allowlist. Horários de Brasília.')),
    escalaTabs(app, tab), body));

  async function start() {
    const cfg = await app.adapter.getEscalaConfig();
    if (!alive) return;
    if (cfg.error) { app.reportError(cfg.error, 'Não foi possível carregar as configurações das entrevistas.'); return; }
    config = cfg.data;
    if (tab === 'agenda') await drawAgenda();
    else if (tab === 'disponibilidade') await drawAvailability();
    else await drawMine();
    app.applyOnline();
  }

  /* ---------- Minha escala ---------- */
  async function drawMine() {
    const today = brasiliaToday();
    const [sessions, escala] = await Promise.all([
      app.adapter.listInterviewSessions({ from: addDays(today, -30), to: addDays(today, 60) }),
      app.adapter.getEscala(),
    ]);
    if (!alive) return;
    if (sessions.error) { app.reportError(sessions.error, 'Não foi possível carregar suas entrevistas.'); return; }
    const mine = sessions.data.filter((s) => isSessionParticipant(s, me));
    const upcoming = mine.filter((s) => s.data_entrevista >= today && !['cancelada', 'registro_concluido', 'concluida'].includes(s.view) && s.view !== 'registro_pendente');
    const pending = mine.filter((s) => s.view === 'registro_pendente');
    const canCancel = canCancelSession(app);
    const card = (s, { cancellable = false } = {}) => {
      const role = s.participantes.find((p) => p.discord_id === me)?.funcao;
      return h('article', { class: 'esc-card', dataset: { id: s.id } },
        h('div', { class: 'esc-card-head' },
          h('div', { class: 'esc-date', 'aria-hidden': 'true' }, h('span', { class: 'esc-day' }, formatDateBr(s.data_entrevista).slice(0, 2)), h('span', { class: 'esc-month' }, ESC_WEEKDAYS_SHORT[weekdayOf(s.data_entrevista)])),
          h('div', { class: 'esc-info' },
            h('h2', { class: 'esc-title' }, `${dayLabel(s.data_entrevista)} às ${horarioLabel(s.horario)}`),
            h('p', { class: 'esc-line' }, statusBadge(s.view), ' ', h('span', { class: 'badge badge--role' }, ESC_ROLE_LABELS[role] ?? role)),
            h('p', { class: 'esc-line' }, peopleLine(s.participantes)))),
        h('div', { class: 'esc-actions' },
          h('a', { class: 'btn btn--sm btn--primary', href: `#/entrevistas/sessao/${s.id}` }, icon('clipboard-text'), s.view === 'registro_pendente' ? 'Fazer o registro' : 'Abrir sessão'),
          copyButton(() => interviewMessage(s.horario, config), { label: 'Copiar mensagem', ariaLabel: `Copiar a mensagem da entrevista das ${horarioLabel(s.horario)}` }),
          cancellable && canCancel && h('button', {
            type: 'button', class: 'btn btn--sm btn--danger', dataset: { action: 'cancel-session' }, 'data-requires-online': '',
            'aria-label': `Cancelar a sessão das ${horarioLabel(s.horario)} de ${formatDateBr(s.data_entrevista)}`,
            onclick: () => cancelSessionFlow(app, s, () => drawMine().then(() => app.applyOnline())),
          }, icon('circle-x'), 'Cancelar sessão')));
    };
    const mySlots = (escala.data?.slots ?? []).filter((s) => s.discord_id === me);
    const published = escala.data?.escala?.status === 'publicada';
    const clearBtn = clearAgendaButton(app, () => drawMine().then(() => app.applyOnline()));
    body.replaceChildren(
      clearBtn && h('div', { class: 'esc-toolbar' }, clearBtn),
      pending.length > 0 && h('section', { class: 'esc-section', id: 'esc-pending' },
        h('h2', { class: 'block-title' }, icon('alert-triangle'), 'Registro pendente'),
        h('p', { class: 'panel-text' }, 'Estas entrevistas já aconteceram e ainda não têm o registro.'),
        h('div', { class: 'esc-list' }, pending.map(card))),
      h('section', { class: 'esc-section', id: 'esc-upcoming' },
        h('h2', { class: 'block-title' }, icon('calendar-event'), 'Próximos horários'),
        upcoming.length
          ? h('div', { class: 'esc-list' }, upcoming.map((s) => card(s, { cancellable: ['agendada', 'em_andamento'].includes(s.status) })))
          : h('div', { class: 'esc-empty', id: 'esc-mine-empty' }, icon('calendar-off'), h('p', {}, 'Você não está escalado(a) para as próximas entrevistas.'))),
      published && mySlots.length > 0 && h('section', { class: 'esc-section' },
        h('h2', { class: 'block-title' }, icon('list-check'), 'Seus horários na escala'),
        h('ul', { class: 'esc-chips', id: 'esc-my-slots' }, sortDays(mySlots.map((s) => s.dia_semana)).flatMap((d) => sortHorarios([...new Set(mySlots.filter((s) => s.dia_semana === d).map((s) => s.horario))])
          .map((hr) => h('li', { class: 'esc-chip' }, `${ESC_WEEKDAYS[d]} · ${horarioLabel(hr)} · ${ESC_ROLE_LABELS[mySlots.find((s) => s.dia_semana === d && s.horario === hr).funcao]}`))))),
      h('p', {}, h('a', { class: 'btn', href: '#/entrevistas/agenda' }, icon('calendar'), 'Ver agenda completa')));
  }

  /* ---------- Agenda ---------- */
  async function drawAgenda() {
    let mode = 'semana';
    let cursor = brasiliaToday();
    let selected = null;
    const grid = h('div', { class: 'esc-agenda', id: 'esc-agenda' });
    const panel = h('aside', { class: 'esc-panel', id: 'esc-panel', 'aria-live': 'polite', hidden: true });
    const label = h('strong', { class: 'esc-range', id: 'esc-range' });
    const shift = (dir) => {
      if (mode === 'semana') cursor = addDays(cursor, dir * 7);
      else { const d = new Date(`${cursor.slice(0, 8)}01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + dir); cursor = d.toISOString().slice(0, 10); }
      draw();
    };
    const modeBtn = (key, text) => h('button', { type: 'button', class: 'esc-mode', 'aria-pressed': String(mode === key), dataset: { mode: key }, onclick: () => { mode = key; draw(); } }, text);
    const bar = h('div', { class: 'esc-bar' });
    body.replaceChildren(bar, h('div', { class: 'esc-agenda-wrap' }, grid, panel));

    async function draw() {
      let from;
      let to;
      if (mode === 'semana') { from = mondayOf(cursor); to = addDays(from, 6); label.textContent = `${formatDateBr(from).slice(0, 5)} a ${formatDateBr(to).slice(0, 5)}`; }
      else {
        const first = `${cursor.slice(0, 8)}01`;
        from = mondayOf(first);
        const last = new Date(Date.UTC(Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7)), 0, 12)).toISOString().slice(0, 10);
        to = addDays(mondayOf(last), 6);
        label.textContent = new Date(`${first}T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      }
      bar.replaceChildren(
        h('div', { class: 'esc-modes', role: 'group', 'aria-label': 'Modo da agenda' }, modeBtn('semana', 'Semana'), modeBtn('mes', 'Mês')),
        h('div', { class: 'esc-nav' },
          h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-prev', 'aria-label': 'Anterior', onclick: () => shift(-1) }, icon('chevron-left')),
          label,
          h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-next', 'aria-label': 'Próximo', onclick: () => shift(1) }, icon('chevron-right')),
          h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'esc-today', onclick: () => { cursor = brasiliaToday(); draw(); } }, 'Hoje')),
        clearAgendaButton(app, async () => { selected = null; panel.hidden = true; await draw(); app.applyOnline(); }));
      const res = await app.adapter.listInterviewSessions({ from, to });
      if (!alive) return;
      if (res.error) { app.reportError(res.error, 'Não foi possível carregar a agenda.'); return; }
      const byDay = new Map();
      for (const s of res.data) { if (!byDay.has(s.data_entrevista)) byDay.set(s.data_entrevista, []); byDay.get(s.data_entrevista).push(s); }
      const chip = (s) => h('button', {
        type: 'button', class: `esc-session esc-session--${s.view}${isSessionParticipant(s, me) ? ' esc-session--mine' : ''}`, dataset: { id: s.id, status: s.view },
        'aria-label': `${dayLabel(s.data_entrevista)} às ${horarioLabel(s.horario)}: ${ESC_SESSION_STATUS_LABELS[s.view]}`, onclick: () => select(s.id),
      }, h('strong', {}, horarioLabel(s.horario)), ' ', h('span', { class: 'esc-session-status' }, ESC_SESSION_STATUS_LABELS[s.view]));
      const days = [];
      for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
      const today = brasiliaToday();
      grid.dataset.mode = mode;
      grid.replaceChildren(...days.map((d) => h('section', {
        class: `esc-day-cell${d === today ? ' esc-day-cell--today' : ''}${mode === 'mes' && d.slice(0, 7) !== cursor.slice(0, 7) ? ' esc-day-cell--out' : ''}`, dataset: { date: d },
      }, h('h3', { class: 'esc-day-title' }, mode === 'semana' ? dayLabel(d) : `${ESC_WEEKDAYS_SHORT[weekdayOf(d)]} ${formatDateBr(d).slice(0, 2)}`),
      (byDay.get(d) ?? []).length ? h('div', { class: 'esc-day-sessions' }, byDay.get(d).map(chip)) : (mode === 'semana' ? h('p', { class: 'esc-none' }, 'Sem entrevistas') : null))));
      if (!res.data.length) grid.prepend(h('p', { class: 'esc-none', id: 'esc-agenda-empty' }, 'Nenhuma entrevista neste período.'));
      if (selected) select(selected, { keep: true });
    }

    async function select(id, { keep = false } = {}) {
      selected = id;
      const res = await app.adapter.getInterviewSession(id);
      if (!alive) return;
      if (res.error) { if (!keep) app.reportError(res.error, 'Não foi possível abrir a sessão.'); return; }
      const s = res.data;
      panel.hidden = false;
      panel.replaceChildren(
        h('div', { class: 'esc-panel-head' },
          h('h2', { class: 'esc-title' }, `${dayLabel(s.data_entrevista)} às ${horarioLabel(s.horario)}`),
          h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-label': 'Fechar painel', onclick: () => { selected = null; panel.hidden = true; } }, icon('x'))),
        h('p', { class: 'esc-line' }, statusBadge(s.view)),
        h('p', { class: 'esc-line' }, peopleLine(s.participantes)),
        s.registro && h('p', { class: 'esc-line' }, `Entrevistados: ${s.registro.total_entrevistados}`),
        h('p', {}, h('a', { class: 'btn btn--primary btn--sm', href: `#/entrevistas/sessao/${s.id}` }, icon('clipboard-text'), 'Abrir sessão')));
    }
    await draw();
  }

  /* ---------- Disponibilidade ---------- */
  async function drawAvailability() {
    const res = await app.adapter.getEscala();
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar a escala.'); return; }
    const { escala, slots, minha_disponibilidade: mineAvail, respondi } = res.data;
    if (!escala) {
      body.replaceChildren(h('div', { class: 'esc-empty', id: 'esc-avail-empty' }, icon('calendar-off'), h('p', {}, 'Nenhuma escala aberta no momento. Quando a Direção abrir, você poderá informar os horários aqui.')));
      return;
    }
    const days = sortDays(config.dias_semana);
    const times = sortHorarios(config.horarios);
    const period = `${formatDateBr(escala.periodo_inicio)} a ${formatDateBr(escala.periodo_fim)}`;

    if (escala.status === 'publicada') {
      const cells = slotsByCell(slots);
      body.replaceChildren(h('section', { class: 'esc-section' },
        h('h2', { class: 'block-title' }, icon('calendar-check'), `Escala oficial · ${period}`),
        h('p', { class: 'panel-text' }, 'Seus horários aparecem destacados.'),
        scheduleTable(days, times, (d, hr) => (cells.get(cellKey(d, hr)) ?? []).map((s) => h('span', { class: `esc-person${s.discord_id === me ? ' esc-person--me' : ''}`, dataset: { me: s.discord_id === me ? 'sim' : 'nao' } },
          `${s.display_name || s.discord_id} (${s.funcao === 'suporte' ? 'sup' : 'all'})`)))));
      return;
    }
    if (escala.status === 'analise') {
      body.replaceChildren(h('div', { class: 'banner banner--info', id: 'esc-avail-analysis' }, icon('hourglass'),
        h('p', {}, `O período de disponibilidade (${period}) terminou. A Direção está montando a escala.`)));
      return;
    }
    if (escala.status !== 'aberta_disponibilidade') {
      body.replaceChildren(h('div', { class: 'esc-empty' }, icon('calendar-off'), h('p', {}, 'Esta escala já foi encerrada.')));
      return;
    }

    const chosen = new Set(mineAvail.map((s) => cellKey(s.dia_semana, s.horario)));
    const closed = Date.parse(escala.encerramento_disponibilidade_em) <= Date.now();
    const countdown = h('strong', { id: 'esc-countdown' });
    const tick = () => {
      const ms = Date.parse(escala.encerramento_disponibilidade_em) - Date.now();
      countdown.textContent = ms > 0 ? countdownText(ms) : 'prazo encerrado';
    };
    tick();
    timer = setInterval(tick, 30_000);
    const summary = h('p', { class: 'esc-line', id: 'esc-avail-count', 'aria-live': 'polite' });
    const saved = h('p', { class: 'banner banner--ok', id: 'esc-avail-saved', role: 'status', hidden: !respondi }, icon('circle-check'), ' ✓ Disponibilidade enviada. Você pode alterar até o prazo.');
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const count = () => { summary.textContent = `${chosen.size} horário(s) marcado(s).`; };
    const toggles = days.map((d) => times.map((hr) => {
      const key = cellKey(d, hr);
      const btn = h('button', {
        type: 'button', class: 'esc-toggle', 'aria-pressed': String(chosen.has(key)), disabled: closed, dataset: { key },
        'aria-label': `${ESC_WEEKDAYS[d]} às ${horarioLabel(hr)}`,
        onclick: () => {
          if (chosen.has(key)) chosen.delete(key); else chosen.add(key);
          btn.setAttribute('aria-pressed', String(chosen.has(key)));
          count();
        },
      }, chosen.has(key) ? '✓' : '○');
      return [key, btn];
    }));
    const byKey = new Map(toggles.flat());
    const saveBtn = h('button', { type: 'button', class: 'btn btn--primary', id: 'esc-avail-save', disabled: closed, 'data-requires-online': '', onclick: async () => {
      saveBtn.disabled = true;
      const out = [...chosen].map((k) => { const [dia, ...rest] = k.split('|'); return { dia_semana: Number(dia), horario: rest.join('|') }; });
      const r = await app.adapter.saveMyAvailability(escala.id, out);
      saveBtn.disabled = false;
      general.hidden = true;
      if (r.error) { general.textContent = r.error.details?.errors?._ ?? r.error.message; general.hidden = false; return; }
      saved.hidden = false;
      toast('✓ Disponibilidade enviada.');
    } }, icon('device-floppy'), 'Salvar disponibilidade');
    count();
    body.replaceChildren(h('section', { class: 'esc-section' },
      h('h2', { class: 'block-title' }, icon('calendar-plus'), `Minha disponibilidade · ${period}`),
      h('p', { class: 'panel-text' }, 'Marque os horários em que você pode entrevistar. Prazo: ', countdown, '.'),
      saved,
      scheduleTable(days, times, (d, hr) => byKey.get(cellKey(d, hr))),
      summary, general, h('div', { class: 'form-actions' }, saveBtn)));
  }

  start();
  return () => { alive = false; if (timer) clearInterval(timer); };
}

/** Tabela dias (colunas) x horários (linhas). `cell(dia, horario)` devolve o conteúdo da célula. */
export function scheduleTable(days, times, cell) {
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'esc-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Horário'), days.map((d) => h('th', { scope: 'col' }, ESC_WEEKDAYS[d])))),
      h('tbody', {}, times.map((hr) => h('tr', {}, h('th', { scope: 'row' }, horarioLabel(hr)), days.map((d) => h('td', { dataset: { dia: d, horario: hr } }, cell(d, hr))))))));
}

export function countdownText(ms) {
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440);
  const hr = Math.floor((min % 1440) / 60);
  if (d > 0) return `${d} dia(s) e ${hr} h`;
  if (hr > 0) return `${hr} h e ${min % 60} min`;
  return `${Math.max(min, 1)} min`;
}

/* ---------------------------------------------------------------------------
 * #/entrevistas/sessao/<id> · detalhe, substituições e registro
 * ------------------------------------------------------------------------- */
export function renderEscalaSessao(app, id) {
  if (!escalaAllowed(app)) return denyEscalas(app);
  const me = app.state.staff.discord_id;
  const canManage = app.can('escalas.gerenciar');
  let alive = true;
  let draft = null;
  let config = null;
  let staffNames = [];
  const slot = h('div', {}, h('p', { class: 'panel-text' }, 'Carregando…'));
  app.els.main.replaceChildren(h('div', { class: 'main-inner esc-page' }, slot));
  let stopPrint = () => {}; // escuta do Ctrl+V do formulário de registro
  const stopDraft = () => { draft?.stop(); draft = null; stopPrint(); stopPrint = () => {}; };

  async function load() {
    const [res, base] = await Promise.all([app.adapter.getInterviewSession(id), loadBase(app)]);
    if (!alive) return;
    if (res.error) {
      if (res.error.code === 'NOT_FOUND') renderMessage(app, { title: 'Sessão não encontrada', text: ESCALA_ERRORS.noSession });
      else app.reportError(res.error, 'Não foi possível abrir a sessão.');
      return;
    }
    config = base.cfg.data;
    staffNames = base.names.data ?? [];
    draw(res.data);
  }

  const failure = (title, error) => openDialog({ title: `✗ ${title}`, body: error.details?.errors?._ ?? error.message ?? 'Tente de novo.', actions: [{ label: 'Entendi', value: true, variant: 'primary', autofocus: true }] });

  function draw(s) {
    stopDraft();
    const mine = isSessionParticipant(s, me);
    const allowed = canManage || mine;
    const closed = s.view === 'cancelada';
    const locked = Boolean(s.registro) && !canManage;
    const g = groupParticipants(s.participantes);
    const present = s.participantes.filter((p) => p.presente !== false);
    const title = `${dayLabel(s.data_entrevista)} às ${horarioLabel(s.horario)}`;

    const personRow = (p) => h('li', { class: `esc-prow${p.presente === false ? ' esc-prow--absent' : ''}`, dataset: { id: p.discord_id } },
      h('span', { class: 'esc-pname' }, p.display_name || p.discord_id),
      h('span', { class: 'badge badge--role' }, ESC_ROLE_LABELS[p.funcao] ?? p.funcao),
      p.substituindo_id && h('span', { class: 'esc-note' }, `no lugar de ${staffNames.find((n) => n.discord_id === p.substituindo_id)?.display_name ?? p.substituindo_id}`),
      p.presente === false && h('span', { class: 'badge badge--revisar' }, 'Ausente'),
      allowed && !locked && !closed && p.presente !== false && h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-label': `Registrar ausência de ${p.display_name}`, 'data-requires-online': '',
        onclick: () => absence(s, p) }, 'Ausência'));

    const sections = [
      h('a', { class: 'back', href: '#/entrevistas' }, icon('arrow-left'), 'Voltar para as entrevistas'),
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title', tabindex: '-1' }, `Entrevista · ${title}`),
        h('p', { class: 'page-sub' }, statusBadge(s.view), s.aviso_enviado && h('span', { class: 'esc-note' }, ' · aviso enviado'))),
      h('section', { class: 'esc-section' },
        h('div', { class: 'esc-actions' },
          allowed && h('button', { type: 'button', class: 'btn btn--sm btn--primary', id: 'esc-start', hidden: !(s.status === 'agendada' && !closed), 'data-requires-online': '', onclick: () => start(s) }, icon('player-play'), 'Iniciar sessão'),
          allowed && copyButton(() => interviewMessage(s.horario, config), { label: 'Copiar mensagem da entrevista', ariaLabel: 'Copiar a mensagem da entrevista' }),
          canManage && !s.aviso_enviado && !closed && h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-notice', 'data-requires-online': '', onclick: () => notice(s) }, icon('bell'), 'Enviar aviso agora'),
          canCancelSession(app) && !['cancelada', 'concluida'].includes(s.status) && h('button', { type: 'button', class: 'btn btn--sm btn--danger', id: 'esc-cancel', 'data-requires-online': '', onclick: () => cancel(s) }, icon('circle-x'), 'Cancelar sessão')),
        h('h2', { class: 'block-title' }, icon('users'), 'Quem está nesta sessão'),
        present.length || g.ausentes.length
          ? h('ul', { class: 'esc-people', id: 'esc-people' }, [...present, ...g.ausentes].map(personRow))
          : h('p', { class: 'panel-text' }, 'Ninguém escalado ainda.'),
        allowed && !locked && !closed && h('p', {}, h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-swap', 'data-requires-online': '', onclick: () => swap(s) }, icon('arrows-exchange'), 'Registrar substituição'))),
      registroSection(s, { allowed, closed }),
      historySection(s),
    ];
    slot.replaceChildren(...sections.filter(Boolean));
    app.applyOnline();
  }

  /* ---------- ações da sessão ---------- */
  async function refreshWith(res, okMessage) {
    if (res.error) { failure('Não foi possível concluir', res.error); return; }
    if (okMessage) toast(okMessage);
    await load();
  }
  async function start(s) {
    const go = await confirmDialog({ title: 'Iniciar a sessão?', message: `A sessão das ${horarioLabel(s.horario)} passa para Em andamento.`, confirmLabel: 'Iniciar' });
    if (go) await refreshWith(await app.adapter.setInterviewSessionStatus(s.id, 'em_andamento'), '✓ Sessão iniciada.');
  }
  const cancel = (s) => cancelSessionFlow(app, s, () => load());
  async function notice(s) {
    const go = await confirmDialog({ title: 'Enviar o aviso agora?', message: 'O aviso vai para o canal de avisos e para o privado de cada escalado, uma vez só.', confirmLabel: 'Enviar aviso' });
    if (!go) return;
    const res = await app.adapter.sendInterviewNotice(s.id);
    if (res.error) { failure('O aviso não foi enviado', res.error); return; }
    const dm = res.data.dm;
    toast(dm?.failed?.length ? `Aviso enviado. Sem privado para ${dm.failed.length} pessoa(s).` : '✓ Aviso enviado.', 4000);
    await load();
  }
  async function absence(s, p) {
    const go = await confirmDialog({ title: 'Registrar ausência?', message: `${p.display_name || p.discord_id} será marcado(a) como ausente nesta sessão.`, confirmLabel: 'Registrar ausência' });
    if (go) await refreshWith(await app.adapter.registerAbsence(s.id, p.discord_id), 'Ausência registrada.');
  }

  async function swap(s) {
    const present = s.participantes.filter((p) => p.presente !== false);
    if (!present.length) { toast('Ninguém para substituir nesta sessão.'); return; }
    const others = staffNames.filter((n) => !present.some((p) => p.discord_id === n.discord_id));
    const fields = {
      original: formField('esc-swap-original', 'Quem sai *', h('select', { class: 'input' }, present.map((p) => h('option', { value: p.discord_id }, `${p.display_name || p.discord_id} (${ESC_ROLE_LABELS[p.funcao]})`)))),
      substituto: formField('esc-swap-new', 'Quem entra *', h('select', { class: 'input' }, others.map((n) => h('option', { value: n.discord_id }, n.display_name)))),
      motivo: formField('esc-swap-reason', 'Motivo (opcional)', h('input', { class: 'input', maxlength: ESC_LIMITS.reason, autocomplete: 'off' })),
    };
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const go = await openDialog({
      title: 'Registrar substituição',
      body: h('div', { id: 'esc-swap-form' }, fields.original.el, fields.substituto.el, fields.motivo.el, general),
      actions: [{ label: 'Cancelar', value: false, variant: 'ghost' }, { label: 'Registrar', value: true, variant: 'primary', autofocus: true }],
    });
    if (!go) return;
    const res = await app.adapter.registerSubstitution(s.id, { original: fields.original.input.value, substituto: fields.substituto.input.value, motivo: fields.motivo.input.value });
    await refreshWith(res, '✓ Substituição registrada.');
  }

  /* ---------- registro ---------- */
  function registroSection(s, { allowed, closed }) {
    if (s.registro) return registroView(s);
    if (closed) return h('section', { class: 'esc-section' }, h('p', { class: 'panel-text' }, 'Sessão cancelada: não há registro.'));
    if (!allowed) return h('section', { class: 'esc-section' }, h('p', { class: 'panel-text', id: 'esc-no-reg' }, 'Esta sessão ainda não tem registro. Só quem está na sessão ou a Direção registra.'));
    return registroForm(s);
  }

  function registroView(s) {
    const r = s.registro;
    const printBox = h('div', { class: 'esc-print', id: 'esc-print-box' }, h('p', { class: 'panel-text' }, 'Carregando o print…'));
    app.adapter.getInterviewPrintUrl(s.id).then((res) => {
      if (!alive) return;
      if (res.error || !res.data) { printBox.replaceChildren(h('p', { class: 'panel-text' }, 'Não foi possível abrir o print.')); return; }
      printBox.replaceChildren(res.data.startsWith('mock-print://') ? h('p', { class: 'panel-text' }, 'Print anexado (modo demonstração).') : h('a', { href: res.data, target: '_blank', rel: 'noopener noreferrer' }, h('img', { class: 'esc-print-img', src: res.data, alt: 'Print da call da entrevista' })));
    });
    return h('section', { class: 'esc-section', id: 'esc-registro' },
      h('h2', { class: 'block-title' }, icon('clipboard-check'), 'Registro da entrevista'),
      h('p', { class: 'banner banner--ok', role: 'status' }, icon('circle-check'), ' Esta sessão já possui um registro.'),
      h('dl', { class: 'esc-dl' },
        h('dt', {}, 'Entrevistados'), h('dd', { id: 'esc-reg-total' }, String(r.total_entrevistados)),
        h('dt', {}, 'Registrado por'), h('dd', {}, `${r.registrado_por_nome ?? r.registrado_por} em ${formatDateBr(brasiliaToday(new Date(r.registrado_em)))}`),
        r.observacoes && [h('dt', {}, 'Observações'), h('dd', { class: 'esc-pre' }, r.observacoes)],
        h('dt', {}, 'Discord'), h('dd', {}, r.discord_message_id ? '✓ Enviado ao canal de registros' : (r.discord_status ?? 'Ainda não enviado')),
        r.editado_por && [h('dt', {}, 'Editado'), h('dd', {}, formatDateBr(brasiliaToday(new Date(r.editado_em))))]),
      printBox,
      h('div', { class: 'esc-actions' },
        (canManage || !r.discord_message_id) && h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-resend', 'data-requires-online': '', onclick: () => resend(s) }, icon('send'), r.discord_message_id ? 'Reenviar ao Discord' : 'Enviar ao Discord'),
        canManage && h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-edit-reg', 'data-requires-online': '', onclick: () => editRegistro(s) }, icon('pencil'), 'Editar registro')));
  }

  async function resend(s) {
    const res = await app.adapter.sendInterviewRegistro(s.id, { resend: canManage });
    if (res.error) { failure('O registro não foi enviado ao Discord', res.error); return; }
    toast('✓ Registro enviado ao Discord.');
    await load();
  }

  async function editRegistro(s) {
    const r = s.registro;
    const fields = {
      total_entrevistados: formField('esc-edit-total', 'Total de entrevistados *', h('input', { class: 'input', type: 'number', min: 0, max: ESC_LIMITS.total, value: r.total_entrevistados })),
      observacoes: formField('esc-edit-notes', 'Observações', h('textarea', { class: 'input textarea', rows: 4, maxlength: ESC_LIMITS.notes }, r.observacoes ?? '')),
      print: formField('esc-edit-print', 'Trocar o print (opcional)', h('input', { class: 'input', type: 'file', accept: 'image/png,image/jpeg,image/webp' })),
    };
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const editPicker = singlePrintPicker(fields.print.input);
    fields.print.el.insertBefore(editPicker.el, fields.print.error);
    const body2 = h('div', { id: 'esc-edit-form' }, fields.total_entrevistados.el, fields.observacoes.el, fields.print.el, general);
    const go = await openDialog({ title: 'Editar registro', body: body2, actions: [{ label: 'Cancelar', value: false, variant: 'ghost' }, { label: 'Salvar', value: true, variant: 'primary', autofocus: true }] });
    const file = fields.print.input.files?.[0] ?? null;
    editPicker.dispose();
    if (!go) return;
    const res = await app.adapter.editInterviewRegistro(s.id, {
      total_entrevistados: fields.total_entrevistados.input.value, observacoes: fields.observacoes.input.value,
      print: file ? { name: file.name, type: file.type, size: file.size, blob: file } : null,
    });
    await refreshWith(res, '✓ Registro atualizado.');
  }

  function registroForm(s) {
    const rows = new Map(s.participantes.map((p) => [p.discord_id, { discord_id: p.discord_id, display_name: p.display_name, funcao: p.funcao, presente: p.presente !== false, substituindo_id: p.substituindo_id ?? '' }]));
    const list = h('div', { class: 'esc-reg-people', id: 'esc-reg-people' });
    const drawRows = () => {
      list.replaceChildren(...[...rows.values()].map((r) => h('div', { class: 'esc-reg-row', dataset: { id: r.discord_id } },
        h('label', { class: 'esc-check' },
          h('input', { type: 'checkbox', checked: r.presente, 'aria-label': `${r.display_name} presente`, onchange: (e) => { r.presente = e.target.checked; } }), ' ', r.display_name || r.discord_id),
        h('select', { class: 'input input--sm', 'aria-label': `Função de ${r.display_name}`, onchange: (e) => { r.funcao = e.target.value; } },
          ESC_PARTICIPANT_ROLES.map((f) => h('option', { value: f, selected: f === r.funcao }, ESC_ROLE_LABELS[f]))),
        r.substituindo_id && h('span', { class: 'esc-note' }, `no lugar de ${staffNames.find((n) => n.discord_id === r.substituindo_id)?.display_name ?? r.substituindo_id}`))));
    };
    drawRows();
    const addSel = h('select', { class: 'input input--sm', id: 'esc-add-person', 'aria-label': 'Adicionar quem não estava escalado' },
      h('option', { value: '' }, 'Adicionar quem entrou de última hora…'),
      staffNames.filter((n) => !rows.has(n.discord_id)).map((n) => h('option', { value: n.discord_id }, n.display_name)));
    addSel.addEventListener('change', () => {
      const n = staffNames.find((x) => x.discord_id === addSel.value);
      if (!n) return;
      rows.set(n.discord_id, { discord_id: n.discord_id, display_name: n.display_name, funcao: 'acompanhante', presente: true, substituindo_id: '' });
      addSel.querySelector(`option[value="${CSS.escape(n.discord_id)}"]`)?.remove();
      addSel.value = '';
      drawRows();
    });
    const fields = {
      total_entrevistados: formField('esc-reg-total-in', 'Total de entrevistados *', h('input', { class: 'input', type: 'number', min: 0, max: ESC_LIMITS.total, inputmode: 'numeric', value: '' })),
      observacoes: formField('esc-reg-notes', 'Observações (opcional)', h('textarea', { class: 'input textarea', rows: 3, maxlength: ESC_LIMITS.notes })),
      print: formField('esc-reg-print', 'Print da call * (PNG, JPG ou WEBP, até 8 MB)', h('input', { class: 'input', type: 'file', accept: 'image/png,image/jpeg,image/webp' }),
        'Mostre quem estava na call da entrevista e quem estava aguardando na fila.'),
    };
    const picker = singlePrintPicker(fields.print.input);
    fields.print.el.insertBefore(picker.el, fields.print.error);
    stopPrint = picker.dispose;
    const peopleError = h('p', { class: 'field-error', id: 'esc-reg-people-err', hidden: true });
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary', id: 'esc-reg-preview', 'data-requires-online': '' }, icon('eye'), 'Revisar e registrar');
    const form = h('form', { class: 'panel staff-form', id: 'esc-reg-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon('clipboard-text'), 'Registrar a entrevista'),
      h('p', { class: 'panel-text' }, `Data e horário: ${formatDateBr(s.data_entrevista)} às ${s.horario}. Confirme quem participou e a função de cada um.`),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Participantes'), list, peopleError, addSel),
      fields.total_entrevistados.el, fields.observacoes.el, fields.print.el, general,
      h('div', { class: 'form-actions' }, submit));
    draft = attachFormDraft(app, `entrevista-registro:${s.id}`, form, { hasContent: (v) => Boolean(String(v['esc-reg-total-in'] ?? '').trim() || String(v['esc-reg-notes'] ?? '').trim()) });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = fields.print.input.files?.[0] ?? null;
      const participantes = [...rows.values()];
      const input = { total_entrevistados: fields.total_entrevistados.input.value, observacoes: fields.observacoes.input.value, participantes };
      const check = validateRegistro({ ...input, tem_print: Boolean(file) });
      showFieldErrors({ ...fields, participantes: { error: peopleError } }, general, check.valid ? null : { details: { errors: check.errors } });
      if (!check.valid) return;
      const present = participantes.filter((p) => p.presente);
      const ok = await openDialog({
        title: 'Confirmar o registro',
        body: h('div', { id: 'esc-reg-preview-body' },
          h('p', {}, `${formatDateBr(s.data_entrevista)} às ${s.horario} · ${Number(input.total_entrevistados)} entrevistado(s)`),
          h('p', {}, `Entrevistadores: ${names(present.filter((p) => p.funcao === 'entrevistador')) || '–'}`),
          h('p', {}, `Suportes e acompanhantes: ${names(present.filter((p) => p.funcao !== 'entrevistador')) || '–'}`),
          participantes.some((p) => !p.presente) && h('p', {}, `Ausentes: ${names(participantes.filter((p) => !p.presente))}`),
          input.observacoes.trim() && h('p', { class: 'esc-pre' }, `Observações: ${input.observacoes.trim()}`),
          h('p', {}, `Print: ${file.name}`),
          h('p', { class: 'field-hint' }, 'Ao confirmar, o registro é salvo e enviado ao canal de registros do Discord.')),
        actions: [{ label: 'Voltar e corrigir', value: false, variant: 'ghost' }, { label: 'Confirmar e registrar', value: true, variant: 'primary', autofocus: true }],
      });
      if (!ok) return;
      submit.disabled = true;
      const res = await app.adapter.registerInterview(s.id, { ...input, print: { name: file.name, type: file.type, size: file.size, blob: file } });
      submit.disabled = false;
      showFieldErrors({ ...fields, participantes: { error: peopleError } }, general, res.error);
      if (res.error) return;
      draft?.clear();
      if (res.data.discord_error) {
        await openDialog({ title: '⚠ Registro salvo, mas não foi ao Discord', body: res.data.discord_error, actions: [{ label: 'Entendi', value: true, variant: 'primary', autofocus: true }] });
      } else toast('✓ Registro salvo e enviado ao Discord.', 4000);
      await load();
    });
    return h('section', { class: 'esc-section', id: 'esc-registro-form' }, form);
  }

  function historySection(s) {
    if (!s.historico?.length) return null;
    const text = (h2) => {
      const d = h2.dados_novos ?? {};
      const who = d.discord_id ? (staffNames.find((n) => n.discord_id === d.discord_id)?.display_name ?? d.discord_id) : '';
      return [who, d.motivo, d.total_entrevistados != null ? `${d.total_entrevistados} entrevistado(s)` : ''].filter(Boolean).join(' · ');
    };
    return h('section', { class: 'esc-section' },
      h('details', { id: 'esc-history' },
        h('summary', { class: 'block-title' }, icon('history'), 'Histórico de alterações da sessão'),
        h('ul', { class: 'esc-history' }, s.historico.map((x) => h('li', {},
          h('strong', {}, ESC_HISTORY_LABELS[x.tipo] ?? x.tipo), ` · ${x.autor_nome ?? x.discord_id} · ${new Date(x.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`,
          text(x) && h('div', { class: 'esc-note' }, text(x)))))));
  }

  load();
  return () => { alive = false; stopDraft(); };
}
