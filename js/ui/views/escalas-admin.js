// Entrevistas · Gestão da Direção (documento 13): #/entrevistas/gestao (painel da escala), /configuracoes e /historico.
// Só escalas.gerenciar (Resp. Equipe, Administrador e CEO, por padrão). A segurança é do banco (24_escalas.sql); aqui só a tela.
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { fromInputValue, toInputValue } from '../../core/agenda.js';
import {
  CELL_LEVEL_LABELS, ESCALA_ERRORS, ESC_HISTORY_LABELS, ESC_ROLE_LABELS, ESC_STATUS_LABELS, ESC_WEEKDAYS, ESC_LIMITS, brasiliaToday, cellKey, cellLevel,
  formatDateBr, horarioLabel, pickEscalaConfig, slotsByCell, slotsSummary, sortDays, sortHorarios, suggestSlots, validateEscalaConfig, validateSlots,
} from '../../core/escalas.js';
import { formField, showFieldErrors } from './gabarito.js';
import { renderMessage } from './message.js';
import { countdownText, scheduleTable } from './escalas.js';

const TABS = Object.freeze([['escala', 'Escala', '#/entrevistas/gestao'], ['configuracoes', 'Configurações', '#/entrevistas/gestao/configuracoes'], ['historico', 'Histórico', '#/entrevistas/gestao/historico']]);
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function renderEscalasAdmin(app, tabKey) {
  if (!app.feature('escalas') || !app.can('escalas.gerenciar')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Só a Direção gerencia a escala das entrevistas.' });
    return null;
  }
  const tab = TABS.some(([k]) => k === tabKey) ? tabKey : 'escala';
  let alive = true;
  let timer = null;
  let config = null;
  const body = h('div', { class: 'esc-body' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  const tabs = h('nav', { class: 'esc-tabs', 'aria-label': 'Seções da gestão' },
    h('a', { class: 'esc-tab', href: '#/entrevistas' }, icon('arrow-left'), ' Entrevistas'),
    TABS.map(([key, label, href]) => h('a', { class: 'esc-tab', href, 'aria-current': tab === key ? 'page' : null, dataset: { tab: key } }, label)));
  app.els.main.replaceChildren(h('div', { class: 'main-inner esc-page' },
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Gestão da escala das entrevistas'),
      h('p', { class: 'page-sub' }, 'Abrir a escala, analisar a disponibilidade, publicar e acompanhar. Horários de Brasília.')),
    tabs, body));

  const failure = (title, error) => openDialog({ title: `✗ ${title}`, body: error.details?.errors?._ ?? error.message ?? 'Tente de novo.', actions: [{ label: 'Entendi', value: true, variant: 'primary', autofocus: true }] });

  async function start() {
    const cfg = await app.adapter.getEscalaConfig();
    if (!alive) return;
    if (cfg.error) { app.reportError(cfg.error, 'Não foi possível carregar as configurações.'); return; }
    config = cfg.data;
    if (tab === 'configuracoes') drawConfig();
    else if (tab === 'historico') await drawHistory();
    else await drawPanel();
    app.applyOnline();
  }

  /* ---------------------------------------------------------------------------
   * Painel da escala (os 4 estados)
   * ------------------------------------------------------------------------- */
  async function drawPanel() {
    if (timer) { clearInterval(timer); timer = null; }
    const res = await app.adapter.getEscala();
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar a escala.'); return; }
    const { escala, slots } = res.data;
    if (!escala) drawNone();
    else if (escala.status === 'aberta_disponibilidade') await drawOpen(escala);
    else if (escala.status === 'analise') await drawAnalysis(escala, slots);
    else drawPublished(escala, slots);
    app.applyOnline();
  }

  function drawNone() {
    body.replaceChildren(h('div', { class: 'esc-empty', id: 'esc-none' }, icon('calendar-plus'),
      h('p', {}, 'Nenhuma escala ativa. Abra uma para os staffs informarem a disponibilidade.'),
      h('button', { type: 'button', class: 'btn btn--primary', id: 'esc-open', 'data-requires-online': '', onclick: openForm }, icon('plus'), 'Abrir escala')));
  }

  function openForm() {
    const today = brasiliaToday();
    const fields = {
      periodo_inicio: formField('esc-open-start', 'Início do período *', h('input', { class: 'input', type: 'date', value: today })),
      periodo_fim: formField('esc-open-end', 'Fim do período *', h('input', { class: 'input', type: 'date', value: addDays(today, 13) })),
      encerramento: formField('esc-open-deadline', 'Prazo para enviar a disponibilidade * (Brasília)', h('input', { class: 'input', type: 'datetime-local', value: toInputValue(new Date(Date.now() + 3 * 86_400_000).toISOString()) })),
    };
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'panel staff-form', id: 'esc-open-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon('calendar-plus'), 'Abrir escala'),
      h('div', { class: 'staff-form-grid' }, fields.periodo_inicio.el, fields.periodo_fim.el), fields.encerramento.el, general,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: drawPanel }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'esc-open-save', 'data-requires-online': '' }, icon('check'), 'Abrir escala')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await app.adapter.openEscala({
        periodo_inicio: fields.periodo_inicio.input.value, periodo_fim: fields.periodo_fim.input.value, encerramento: fromInputValue(fields.encerramento.input.value),
      });
      showFieldErrors(fields, general, res.error);
      if (res.error) return;
      toast('✓ Escala aberta para disponibilidade.');
      await drawPanel();
    });
    body.replaceChildren(form);
    app.applyOnline();
  }

  async function drawOpen(escala) {
    const sum = await app.adapter.getAvailabilitySummary(escala.id);
    if (!alive) return;
    if (sum.error) { app.reportError(sum.error, 'Não foi possível carregar a disponibilidade.'); return; }
    const { membros } = sum.data;
    const done = membros.filter((m) => m.respondeu);
    const waiting = membros.filter((m) => !m.respondeu);
    const pct = membros.length ? Math.round((done.length / membros.length) * 100) : 0;
    const countdown = h('strong', { id: 'esc-countdown' });
    const tick = () => {
      const ms = Date.parse(escala.encerramento_disponibilidade_em) - Date.now();
      countdown.textContent = ms > 0 ? countdownText(ms) : 'prazo encerrado';
    };
    tick();
    timer = setInterval(tick, 30_000);
    const list = (arr, cls) => h('ul', { class: `esc-chips ${cls}` }, arr.length ? arr.map((m) => h('li', { class: 'esc-chip' }, m.display_name)) : h('li', { class: 'esc-none' }, 'Ninguém.'));
    body.replaceChildren(h('section', { class: 'esc-section' },
      h('h2', { class: 'block-title' }, icon('hourglass'), `Aberta para disponibilidade · ${formatDateBr(escala.periodo_inicio)} a ${formatDateBr(escala.periodo_fim)}`),
      h('p', { class: 'panel-text' }, 'Tempo até o encerramento: ', countdown, '.'),
      h('div', { class: 'esc-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Quem já informou a disponibilidade' },
        h('div', { class: 'esc-progress-bar', style: `width:${pct}%` })),
      h('p', { class: 'esc-line', id: 'esc-progress-text' }, `${done.length} de ${membros.length} já informaram (${pct}%).`),
      h('div', { class: 'esc-two' },
        h('div', {}, h('h3', { class: 'esc-sub' }, `Já enviaram (${done.length})`), list(done, 'esc-chips--ok')),
        h('div', {}, h('h3', { class: 'esc-sub' }, `Ainda não enviaram (${waiting.length})`), list(waiting, 'esc-chips--wait'))),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'esc-close-avail', 'data-requires-online': '', onclick: async () => {
          const go = await confirmDialog({ title: 'Encerrar o período?', message: `${waiting.length} pessoa(s) ainda não informaram. Ao encerrar, ninguém mais altera a disponibilidade e a escala vai para análise.`, confirmLabel: 'Encerrar período' });
          if (!go) return;
          const r = await app.adapter.closeAvailability(escala.id);
          if (r.error) { failure('Não foi possível encerrar', r.error); return; }
          toast('Período encerrado. A escala está em análise.');
          await drawPanel();
        } }, icon('lock'), 'Encerrar período'))));
  }

  /* ---------- análise ---------- */
  async function drawAnalysis(escala, saved) {
    const sum = await app.adapter.getAvailabilitySummary(escala.id);
    if (!alive) return;
    if (sum.error) { app.reportError(sum.error, 'Não foi possível carregar a disponibilidade.'); return; }
    const { membros, celulas } = sum.data;
    const nameOf = (id) => membros.find((m) => m.discord_id === id)?.display_name ?? id;
    const available = new Map(celulas.map((c) => [cellKey(c.dia_semana, c.horario), c.discord_ids]));
    let slots = saved.map(({ dia_semana, horario, discord_id, funcao }) => ({ dia_semana, horario, discord_id, funcao }));
    const days = sortDays(config.dias_semana);
    const times = sortHorarios(config.horarios);
    const holder = h('div', { id: 'esc-grid' });
    const status = h('p', { class: 'esc-line', id: 'esc-draft-state', 'aria-live': 'polite' });

    const has = (d, hr, id) => slots.some((s) => s.dia_semana === d && s.horario === hr && s.discord_id === id);
    const add = (d, hr, id, funcao = 'entrevistador') => { if (!has(d, hr, id)) slots.push({ dia_semana: d, horario: hr, discord_id: id, funcao }); };
    const remove = (d, hr, id) => { slots = slots.filter((s) => !(s.dia_semana === d && s.horario === hr && s.discord_id === id)); };

    function cell(d, hr) {
      const key = cellKey(d, hr);
      const avail = available.get(key) ?? [];
      const level = cellLevel(avail.length);
      const assigned = slots.filter((s) => s.dia_semana === d && s.horario === hr);
      const pool = avail.filter((id) => !has(d, hr, id));
      const others = membros.filter((m) => !has(d, hr, m.discord_id) && !avail.includes(m.discord_id));
      return [
        h('span', { class: `esc-level esc-level--${level}`, title: CELL_LEVEL_LABELS[level], dataset: { level } }, `${avail.length} disp. · ${CELL_LEVEL_LABELS[level]}`),
        h('ul', { class: 'esc-assigned', 'aria-label': 'Escalados' }, assigned.map((s) => h('li', {
          class: `esc-person esc-person--${s.funcao}`, draggable: 'true', dataset: { id: s.discord_id, funcao: s.funcao },
          ondragstart: (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ d, hr, id: s.discord_id, funcao: s.funcao })); e.dataTransfer.effectAllowed = 'move'; },
        },
        nameOf(s.discord_id), ' ',
        h('button', { type: 'button', class: 'esc-mini', 'aria-label': `Trocar função de ${nameOf(s.discord_id)} (agora ${ESC_ROLE_LABELS[s.funcao]})`, title: 'Trocar entre entrevistador e suporte',
          onclick: () => { s.funcao = s.funcao === 'entrevistador' ? 'suporte' : 'entrevistador'; redraw(); } }, s.funcao === 'suporte' ? 'sup' : 'all'),
        h('button', { type: 'button', class: 'esc-mini', 'aria-label': `Tirar ${nameOf(s.discord_id)} deste horário`, onclick: () => { remove(d, hr, s.discord_id); redraw(); } }, '✗')))),
        pool.length > 0 && h('ul', { class: 'esc-pool', 'aria-label': 'Disponíveis, clique para escalar' }, pool.map((id) => h('li', {},
          h('button', { type: 'button', class: 'esc-chip esc-chip--add', 'aria-label': `Escalar ${nameOf(id)}`, onclick: () => { add(d, hr, id); redraw(); } }, `+ ${nameOf(id)}`)))),
        others.length > 0 && h('select', { class: 'input input--sm esc-other', 'aria-label': `Escalar quem não marcou disponibilidade: ${ESC_WEEKDAYS[d]} ${horarioLabel(hr)}`,
          onchange: (e) => { if (e.target.value) { add(d, hr, e.target.value); redraw(); } } },
        h('option', { value: '' }, '+ outra pessoa…'), others.map((m) => h('option', { value: m.discord_id }, m.display_name))),
      ];
    }

    function redraw() {
      const table = scheduleTable(days, times, cell);
      for (const td of table.querySelectorAll('td')) {
        const d = Number(td.dataset.dia);
        const hr = td.dataset.horario;
        td.addEventListener('dragover', (e) => { e.preventDefault(); td.classList.add('esc-drop'); });
        td.addEventListener('dragleave', () => td.classList.remove('esc-drop'));
        td.addEventListener('drop', (e) => {
          e.preventDefault();
          td.classList.remove('esc-drop');
          try {
            const src = JSON.parse(e.dataTransfer.getData('text/plain'));
            if (src.d === d && src.hr === hr) return;
            remove(src.d, src.hr, src.id);
            add(d, hr, src.id, src.funcao);
            redraw();
          } catch { /* arrastou outra coisa */ }
        });
      }
      holder.replaceChildren(table);
      const sm = slotsSummary(slots, config);
      status.textContent = `${sm.slots} escalado(s) em ${sm.cells} horário(s) · ${sm.people} pessoa(s)${sm.empty.length ? ` · ${sm.empty.length} horário(s) sem ninguém` : ''}.`;
      app.applyOnline();
    }

    async function persist() {
      const check = validateSlots(slots);
      if (!check.valid) { failure('Lista inválida', { message: ESCALA_ERRORS.list }); return false; }
      const r = await app.adapter.saveEscalaSlots(escala.id, slots);
      if (r.error) { failure('Não foi possível salvar o rascunho', r.error); return false; }
      return true;
    }

    async function publish() {
      const sm = slotsSummary(slots, config);
      if (!sm.slots) { failure('Defina a escala', { message: ESCALA_ERRORS.empty }); return; }
      const go = await openDialog({
        title: 'Definir a escala?',
        body: h('div', { id: 'esc-confirm-body' },
          h('p', {}, `Período: ${formatDateBr(escala.periodo_inicio)} a ${formatDateBr(escala.periodo_fim)}.`),
          h('p', {}, `${sm.slots} escalado(s) em ${sm.cells} horário(s), ${sm.people} pessoa(s) diferentes.`),
          sm.empty.length > 0 && h('p', { class: 'field-error' }, `⚠ Sem ninguém: ${sm.empty.map((c) => `${ESC_WEEKDAYS[c.dia_semana]} ${horarioLabel(c.horario)}`).join(', ')}.`),
          h('p', { class: 'field-hint' }, 'Ao confirmar, as sessões do período são criadas e a escala é enviada ao Discord.')),
        actions: [{ label: 'Voltar', value: false, variant: 'ghost' }, { label: 'Definir escala', value: true, variant: 'primary', autofocus: true }],
      });
      if (!go) return;
      if (!(await persist())) return;
      const r = await app.adapter.publishEscala(escala.id);
      if (r.error) { failure('A escala não foi publicada', r.error); return; }
      if (r.data.discord_error) {
        await openDialog({ title: '⚠ Escala publicada, mas não foi ao Discord', body: `${r.data.discord_error} Corrija e use "Reenviar ao Discord" na escala publicada.`, actions: [{ label: 'Entendi', value: true, variant: 'primary', autofocus: true }] });
      } else toast(`✓ Escala publicada. ${r.data.sessoes} sessão(ões) criada(s).`, 4000);
      await drawPanel();
    }

    body.replaceChildren(h('section', { class: 'esc-section' },
      h('h2', { class: 'block-title' }, icon('table'), `Em análise · ${formatDateBr(escala.periodo_inicio)} a ${formatDateBr(escala.periodo_fim)}`),
      h('p', { class: 'panel-text' }, 'Verde: 3 ou mais disponíveis. Amarelo: poucos. Vermelho: ninguém. Clique em "+ nome" para escalar, ✗ para tirar, "all/sup" para trocar a função, ou arraste uma pessoa para outro horário.'),
      h('div', { class: 'esc-actions' },
        h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-suggest', onclick: () => { slots = suggestSlots(celulas); redraw(); } }, icon('wand'), 'Começar com todos os disponíveis'),
        h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'esc-clear', onclick: () => { slots = []; redraw(); } }, icon('eraser'), 'Limpar'),
        h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-save-draft', 'data-requires-online': '', onclick: async () => { if (await persist()) toast('✓ Rascunho salvo.'); } }, icon('device-floppy'), 'Salvar rascunho')),
      holder, status,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'esc-publish', 'data-requires-online': '', onclick: publish }, icon('send'), 'Definir escala'))));
    redraw();
  }

  /* ---------- publicada ---------- */
  function drawPublished(escala, slots) {
    const days = sortDays(config.dias_semana);
    const times = sortHorarios(config.horarios);
    const cells = slotsByCell(slots);
    const eligiblePromise = app.adapter.getAvailabilitySummary(escala.id);
    const personChip = (s) => h('span', { class: `esc-person esc-person--${s.funcao}`, dataset: { id: s.discord_id, slot: s.id } },
      `${s.display_name || s.discord_id} (${s.funcao === 'suporte' ? 'sup' : 'all'})`, ' ',
      h('button', { type: 'button', class: 'esc-mini', 'aria-label': `Realocar ${s.display_name || s.discord_id}`, title: 'Trocar por outra pessoa', 'data-requires-online': '', onclick: () => reallocate(s) }, icon('arrows-exchange')));

    async function reallocate(s) {
      const sum = await eligiblePromise;
      const options = (sum.data?.membros ?? []).filter((m) => !(cells.get(cellKey(s.dia_semana, s.horario)) ?? []).some((x) => x.discord_id === m.discord_id));
      const select = h('select', { class: 'input', id: 'esc-realloc-select', 'aria-label': 'Quem entra' }, options.map((m) => h('option', { value: m.discord_id }, m.display_name)));
      const go = await openDialog({
        title: 'Realocar horário',
        body: h('div', {}, h('p', {}, `${ESC_WEEKDAYS[s.dia_semana]} às ${horarioLabel(s.horario)}: sai ${s.display_name || s.discord_id}. As sessões futuras ainda sem registro acompanham a troca.`), select),
        actions: [{ label: 'Cancelar', value: false, variant: 'ghost' }, { label: 'Realocar', value: true, variant: 'primary', autofocus: true }],
      });
      if (!go) return;
      const r = await app.adapter.reallocateSlot(s.id, select.value);
      if (r.error) { failure('Não foi possível realocar', r.error); return; }
      toast('✓ Horário realocado.');
      await drawPanel();
    }

    body.replaceChildren(h('section', { class: 'esc-section' },
      h('h2', { class: 'block-title' }, icon('calendar-check'), `Escala publicada · ${formatDateBr(escala.periodo_inicio)} a ${formatDateBr(escala.periodo_fim)}`),
      h('p', { class: 'esc-line', id: 'esc-discord-state' }, `Discord: ${escala.discord_status ?? 'ainda não enviada'}`),
      scheduleTable(days, times, (d, hr) => (cells.get(cellKey(d, hr)) ?? []).map(personChip)),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn', id: 'esc-resend-escala', 'data-requires-online': '', onclick: async () => {
          const r = await app.adapter.sendEscalaToDiscord(escala.id);
          if (r.error) { failure('A escala não foi enviada', r.error); return; }
          toast('✓ Escala enviada ao Discord.');
          await drawPanel();
        } }, icon('send'), 'Reenviar ao Discord'),
        h('a', { class: 'btn btn--ghost', href: '#/entrevistas/gestao/historico' }, icon('history'), 'Ver escalas anteriores'),
        h('button', { type: 'button', class: 'btn btn--danger', id: 'esc-end', 'data-requires-online': '', onclick: async () => {
          const go = await confirmDialog({ title: 'Encerrar a escala?', message: 'A escala deixa de estar ativa e você poderá abrir uma nova. As sessões já criadas continuam na agenda.', confirmLabel: 'Encerrar escala', danger: true });
          if (!go) return;
          const r = await app.adapter.endEscala(escala.id);
          if (r.error) { failure('Não foi possível encerrar', r.error); return; }
          toast('Escala encerrada.');
          await drawPanel();
        } }, icon('lock'), 'Encerrar escala'))));
  }

  /* ---------------------------------------------------------------------------
   * Configurações
   * ------------------------------------------------------------------------- */
  function drawConfig() {
    let times = [...config.horarios];
    const dayBoxes = [1, 2, 3, 4, 5, 6, 0].map((d) => h('label', { class: 'esc-check' },
      h('input', { type: 'checkbox', name: 'dia', value: String(d), checked: config.dias_semana.includes(d) }), ' ', ESC_WEEKDAYS[d]));
    const timesBox = h('div', { class: 'esc-times', id: 'esc-times' });
    const timeInput = h('input', { class: 'input input--sm', type: 'time', id: 'esc-time-new', 'aria-label': 'Novo horário' });
    const drawTimes = () => timesBox.replaceChildren(...sortHorarios(times).map((t) => h('span', { class: 'esc-chip' }, horarioLabel(t), ' ',
      h('button', { type: 'button', class: 'esc-mini', 'aria-label': `Remover o horário ${t}`, onclick: () => { times = times.filter((x) => x !== t); drawTimes(); } }, '✗'))));
    drawTimes();
    const text = (id, label, key, hint, extra = {}) => formField(id, label, h('input', { class: 'input', autocomplete: 'off', value: config[key] ?? '', inputmode: extra.numeric ? 'numeric' : null, maxlength: extra.max ?? 200 }), hint);
    const fields = {
      antecedencia_aviso_minutos: formField('esc-cfg-notice', 'Avisar quantos minutos antes *', h('input', { class: 'input', type: 'number', min: 0, max: ESC_LIMITS.antecedencia, value: config.antecedencia_aviso_minutos }), 'O aviso vai para o canal de avisos e para o privado de cada escalado.'),
      canal_discord_escala: text('esc-cfg-ch-escala', 'ID do canal da escala', 'canal_discord_escala', 'Onde o bot publica a escala (ex.: escala-entrevistas). Em branco = não publica.'),
      canal_discord_registros: text('esc-cfg-ch-registros', 'ID do canal dos registros', 'canal_discord_registros', 'Onde o bot posta cada registro de entrevista.'),
      canal_discord_avisos: text('esc-cfg-ch-avisos', 'ID do canal dos avisos', 'canal_discord_avisos', 'Onde o bot avisa que a entrevista vai começar.'),
      cargo_discord_entrevistador: text('esc-cfg-role-all', 'ID do cargo dos entrevistadores (@all)', 'cargo_discord_entrevistador', 'Aparece na escala do Discord. Em branco = escreve "@all" em texto.'),
      cargo_discord_suporte: text('esc-cfg-role-sup', 'ID do cargo dos suportes (@sup)', 'cargo_discord_suporte', 'Em branco = escreve "@sup" em texto.'),
      mensagem_link_call: text('esc-cfg-link', 'Link da call de entrevistas *', 'mensagem_link_call', 'Entra no botão "Cliquem Aqui" da mensagem para copiar.', { max: 300 }),
      mensagem_cargo_id: text('esc-cfg-msg-role', 'ID do cargo marcado na mensagem para copiar *', 'mensagem_cargo_id', 'Quem é marcado em "Fiquem atentos!".'),
    };
    const errors = { dias_semana: { error: h('p', { class: 'field-error', id: 'esc-cfg-days-err', hidden: true }) }, horarios: { error: h('p', { class: 'field-error', id: 'esc-cfg-times-err', hidden: true }) } };
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'panel staff-form', id: 'esc-cfg-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon('settings'), 'Configurações das entrevistas'),
      h('fieldset', { class: 'agenda-fieldset' }, h('legend', { class: 'field-label' }, 'Dias com entrevistas'), h('div', { class: 'agenda-checks', id: 'esc-cfg-days' }, dayBoxes), errors.dias_semana.error),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Horários'), timesBox,
        h('div', { class: 'esc-actions' }, timeInput, h('button', { type: 'button', class: 'btn btn--sm', id: 'esc-time-add', onclick: () => {
          if (timeInput.value && !times.includes(timeInput.value)) { times.push(timeInput.value); drawTimes(); }
          timeInput.value = '';
        } }, icon('plus'), 'Adicionar horário')), errors.horarios.error),
      fields.antecedencia_aviso_minutos.el,
      h('div', { class: 'staff-form-grid' }, fields.canal_discord_escala.el, fields.canal_discord_registros.el, fields.canal_discord_avisos.el),
      h('div', { class: 'staff-form-grid' }, fields.cargo_discord_entrevistador.el, fields.cargo_discord_suporte.el),
      h('div', { class: 'staff-form-grid' }, fields.mensagem_link_call.el, fields.mensagem_cargo_id.el), general,
      h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn--primary', id: 'esc-cfg-save', 'data-requires-online': '' }, icon('device-floppy'), 'Salvar configurações')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = pickEscalaConfig({
        dias_semana: [...form.querySelectorAll('input[name="dia"]:checked')].map((i) => Number(i.value)), horarios: times,
        antecedencia_aviso_minutos: fields.antecedencia_aviso_minutos.input.value,
        ...Object.fromEntries(Object.keys(fields).filter((k) => k !== 'antecedencia_aviso_minutos').map((k) => [k, fields[k].input.value])),
      });
      const check = validateEscalaConfig(input);
      showFieldErrors({ ...fields, ...errors }, general, check.valid ? null : { details: { errors: check.errors } });
      if (!check.valid) return;
      const go = await confirmDialog({ title: 'Salvar as configurações?', message: 'Valem para as próximas escalas, avisos e registros.', confirmLabel: 'Salvar' });
      if (!go) return;
      const res = await app.adapter.saveEscalaConfig(input);
      showFieldErrors({ ...fields, ...errors }, general, res.error);
      if (res.error) return;
      config = res.data;
      toast('✓ Configurações salvas.');
    });
    body.replaceChildren(form);
    app.applyOnline();
  }

  /* ---------------------------------------------------------------------------
   * Histórico: escalas anteriores e registro de auditoria
   * ------------------------------------------------------------------------- */
  async function drawHistory() {
    const [list, audit] = await Promise.all([app.adapter.listEscalas(), app.adapter.listEscalaHistory({ limit: 100 })]);
    if (!alive) return;
    for (const r of [list, audit]) if (r.error) { app.reportError(r.error, 'Não foi possível carregar o histórico.'); return; }
    const detail = h('div', { id: 'esc-hist-detail' });
    async function view(e) {
      const r = await app.adapter.getEscala(e.id);
      if (r.error) { failure('Não foi possível abrir a escala', r.error); return; }
      const cells = slotsByCell(r.data.slots);
      detail.replaceChildren(h('section', { class: 'esc-section' },
        h('h3', { class: 'esc-sub' }, `Escala ${formatDateBr(e.periodo_inicio)} a ${formatDateBr(e.periodo_fim)}`),
        scheduleTable(sortDays(config.dias_semana), sortHorarios(config.horarios), (d, hr) => (cells.get(cellKey(d, hr)) ?? []).map((s) =>
          h('span', { class: `esc-person esc-person--${s.funcao}` }, `${s.display_name || s.discord_id} (${s.funcao === 'suporte' ? 'sup' : 'all'})`)))));
    }
    const when = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const summaryOf = (x) => {
      const d = x.dados_novos ?? {};
      return [d.periodo_inicio && `${formatDateBr(d.periodo_inicio)} a ${formatDateBr(d.periodo_fim)}`, d.status && ESC_STATUS_LABELS[d.status], d.sessoes_criadas != null && `${d.sessoes_criadas} sessão(ões)`,
        d.motivo, d.total_entrevistados != null && `${d.total_entrevistados} entrevistado(s)`].filter(Boolean).join(' · ');
    };
    body.replaceChildren(
      h('section', { class: 'esc-section' },
        h('h2', { class: 'block-title' }, icon('calendar-stats'), 'Escalas'),
        list.data.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'esc-table', id: 'esc-hist-escalas' },
            h('thead', {}, h('tr', {}, ['Período', 'Situação', 'Horários', 'Sessões', ''].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', {}, list.data.map((e) => h('tr', { dataset: { id: e.id } },
              h('td', {}, `${formatDateBr(e.periodo_inicio)} a ${formatDateBr(e.periodo_fim)}`), h('td', {}, ESC_STATUS_LABELS[e.status]),
              h('td', {}, String(e.slots_total)), h('td', {}, String(e.sessoes_total)),
              h('td', {}, h('button', { type: 'button', class: 'btn btn--sm', onclick: () => view(e) }, 'Ver')))))))
          : h('p', { class: 'panel-text' }, 'Nenhuma escala ainda.'),
        detail),
      h('section', { class: 'esc-section' },
        h('h2', { class: 'block-title' }, icon('history'), 'Registro de ações'),
        audit.data.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'esc-table', id: 'esc-hist-audit' },
            h('thead', {}, h('tr', {}, ['Quando', 'Ação', 'Quem', 'Detalhes'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', {}, audit.data.map((x) => h('tr', {}, h('td', {}, when(x.criado_em)), h('td', {}, ESC_HISTORY_LABELS[x.tipo] ?? x.tipo),
              h('td', {}, x.autor_nome ?? x.discord_id), h('td', { class: 'esc-wrap' }, summaryOf(x)))))))
          : h('p', { class: 'panel-text' }, 'Nada registrado ainda.')));
  }

  start();
  return () => { alive = false; if (timer) clearInterval(timer); };
}
