// Etapa 8 · gabarito da entrevista e checklist (documento 02, seção 9, Fase 5): #/gabarito.
// Só lore.gerenciar (Lore, Head Staff e Direção; Decisão 2). Desativar em vez de apagar: as
// entrevistas antigas guardam uma cópia do texto da pergunta.
import { h, icon, toast } from '../dom.js';
import { statusBadge } from '../components.js';
import { QUESTION_KINDS, QUESTION_SECTIONS } from '../../core/allowlist.js';
import { LORE_LIMITS } from '../../core/lore.js';
import { errorText } from './allowlist.js';
import { renderMessage } from './message.js';
import { canDestroy, runDestructive } from '../destructive.js';

/**
 * Campo de formulário com rótulo e erro. `control` pode ser input, textarea ou select.
 * Devolve { el, input, error }.
 */
export function formField(id, label, control, hint = '') {
  control.id = id;
  const error = h('p', { class: 'field-error', id: `${id}-err`, hidden: true });
  return { el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), control, hint && h('p', { class: 'field-hint' }, hint), error), input: control, error };
}

/** Mostra os erros de validação por campo (fields: { chave: formField }) e o geral em `general`. */
export function showFieldErrors(fields, general, error) {
  for (const f of Object.values(fields)) f.error.hidden = true;
  general.hidden = true;
  if (!error) return;
  const errors = error.details?.errors ?? {};
  let shown = false;
  for (const [k, msg] of Object.entries(errors)) {
    if (fields[k]) { fields[k].error.textContent = msg; fields[k].error.hidden = false; shown = true; }
  }
  if (!shown || errors._) { general.textContent = errors._ ?? errorText(error); general.hidden = false; }
}

const select = (options, value) => h('select', { class: 'input' },
  Object.entries(options).map(([v, t]) => h('option', { value: v, selected: String(value) === String(v) }, t)));

export function renderGabarito(app) {
  if (!app.feature('allowlist') || !app.can('lore.gerenciar')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Só a equipe de Lore, o Head Staff e a Direção editam o gabarito.' });
    return null;
  }
  let alive = true;
  let showOff = false;
  let data = { questions: [], items: [] };
  const qList = h('ul', { class: 'staff-list', id: 'gab-questions' }, h('li', { class: 'staff-empty' }, 'Carregando…'));
  const cList = h('ul', { class: 'staff-list', id: 'gab-checklist' });
  const formSlot = h('div', {});
  const toggle = h('input', { type: 'checkbox', id: 'gab-show-off', onchange: (e) => { showOff = e.target.checked; draw(); } });

  app.els.main.replaceChildren(h('div', { class: 'main-inner gabarito-page' },
    h('a', { class: 'back', href: '#/entrevista' }, icon('arrow-left'), 'Nova entrevista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Gabarito e checklist'),
      h('p', { class: 'page-sub' }, 'Perguntas e itens que aparecem na tela de entrevista. Desative o que não usa mais: as entrevistas antigas guardam uma cópia do texto.'),
      h('div', { class: 'page-head-actions' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'gab-new-question', onclick: () => openQuestion(null) }, icon('plus'), 'Nova pergunta'),
        h('button', { type: 'button', class: 'btn', id: 'gab-new-item', onclick: () => openItem(null) }, icon('plus'), 'Novo item do checklist'))),
    h('label', { class: 'check' }, toggle, 'Mostrar os desativados'),
    formSlot,
    h('section', { class: 'panel', 'aria-labelledby': 'gab-q-title' }, h('h2', { class: 'block-title', id: 'gab-q-title' }, icon('help'), 'Perguntas do gabarito'), qList),
    h('section', { class: 'panel', 'aria-labelledby': 'gab-c-title' }, h('h2', { class: 'block-title', id: 'gab-c-title' }, icon('list-check'), 'Checklist da entrevista'), cList)));

  async function load() {
    const [q, c] = await Promise.all([app.adapter.listInterviewQuestions({ includeInactive: true }), app.adapter.listChecklistItems({ includeInactive: true })]);
    if (!alive) return;
    const err = [q, c].find((r) => r.error);
    if (err) { app.reportError(err.error, 'Não foi possível carregar o gabarito.'); return; }
    data = { questions: q.data, items: c.data };
    draw();
  }

  // Permissão e instalação do SQL 25 conferidas uma vez ao abrir a tela (o banco confere de novo ao apagar).
  const erasable = canDestroy(app, 'gabarito.apagar');
  const erase = (kind, item, title) => runDestructive(app, kind, {
    detail: h('p', {}, h('strong', {}, title)),
    call: (reason) => (kind === 'question' ? app.adapter.deleteInterviewQuestion(item.id, reason) : app.adapter.deleteChecklistItem(item.id, reason)),
    okMessage: kind === 'question' ? 'Pergunta apagada. O texto ficou guardado na auditoria.' : 'Item apagado. O texto ficou guardado na auditoria.',
    onDone: () => load(),
  });

  const row = (item, title, meta, onEdit, kind) => h('li', { class: `staff-row${item.active ? '' : ' staff-row--off'}`, dataset: { id: item.id } },
    h('div', { class: 'staff-who' }, h('p', { class: 'staff-name' }, title), h('p', { class: 'staff-meta' }, meta)),
    h('div', { class: 'staff-tags' }, statusBadge(item.active)),
    h('div', { class: 'staff-actions' },
      h('button', { type: 'button', class: 'btn btn--sm', 'aria-label': `Editar: ${title}`, onclick: onEdit }, icon('pencil'), 'Editar'),
      erasable && h('button', {
        type: 'button', class: 'btn btn--sm btn--ghost btn--danger', dataset: { action: 'erase' }, 'data-requires-online': '',
        'aria-label': `Apagar para sempre: ${title}`, onclick: () => erase(kind, item, title),
      }, icon('trash'), 'Apagar')));

  function draw() {
    const vis = (x) => showOff || x.active;
    const qs = data.questions.filter(vis);
    qList.replaceChildren(...(qs.length ? qs.map((q) => row(q, q.question, `${q.position} · ${q.section} · ${QUESTION_KINDS[q.kind] ?? q.kind}`, () => openQuestion(q), 'question'))
      : [h('li', { class: 'staff-empty' }, 'Nenhuma pergunta.')]));
    const cs = data.items.filter(vis);
    cList.replaceChildren(...(cs.length ? cs.map((c) => row(c, c.text, `Etapa ${c.stage} (${c.stage_title}) · ordem ${c.position}${c.hint ? ` · ${c.hint}` : ''}`, () => openItem(c), 'item'))
      : [h('li', { class: 'staff-empty' }, 'Nenhum item.')]));
  }

  function openForm({ title, fields, active, onSave, focus }) {
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const activeBox = h('input', { type: 'checkbox', id: 'gab-active', checked: active });
    const form = h('form', { class: 'panel staff-form', id: 'gab-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon('pencil'), title),
      h('div', { class: 'staff-form-grid' }, Object.values(fields).map((f) => f.el)),
      h('label', { class: 'check' }, activeBox, 'Ativo (aparece na entrevista)'),
      general,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => formSlot.replaceChildren() }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'gab-save', 'data-requires-online': '' }, icon('device-floppy'), 'Salvar')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.input.value]));
      const res = await onSave({ ...values, active: activeBox.checked });
      showFieldErrors(fields, general, res.error);
      if (res.error) return;
      toast('Salvo.');
      formSlot.replaceChildren();
      load();
    });
    formSlot.replaceChildren(form);
    app.applyOnline();
    fields[focus].input.focus();
  }

  function openQuestion(q) {
    const fields = {
      section: formField('gab-section', 'Seção *', select(Object.fromEntries(QUESTION_SECTIONS.map((s) => [s, s])), q?.section ?? QUESTION_SECTIONS[0])),
      kind: formField('gab-kind', 'Tipo *', select(QUESTION_KINDS, q?.kind ?? 'lore')),
      position: formField('gab-position', 'Ordem', h('input', { class: 'input', type: 'number', min: 0, max: 9999, value: q?.position ?? '' }), 'Vazio = no fim da lista.'),
      question: formField('gab-question', 'Pergunta *', h('textarea', { class: 'textarea', rows: 2, maxlength: LORE_LIMITS.question }, q?.question ?? '')),
      answer: formField('gab-answer', 'Resposta esperada', h('textarea', { class: 'textarea', rows: 3, maxlength: LORE_LIMITS.answer }, q?.answer ?? '')),
      extra_note: formField('gab-extra', 'Observação para o entrevistador', h('textarea', { class: 'textarea', rows: 2, maxlength: LORE_LIMITS.extra_note }, q?.extra_note ?? '')),
    };
    openForm({ title: q ? 'Editar pergunta' : 'Nova pergunta', fields, active: q ? q.active : true, focus: 'question',
      onSave: (v) => app.adapter.saveInterviewQuestion({ ...(q ? { id: q.id } : {}), ...v }) });
  }

  function openItem(c) {
    const fields = {
      stage: formField('gab-stage', 'Etapa *', select({ 1: '1', 2: '2', 3: '3', 4: '4' }, c?.stage ?? 1)),
      stage_title: formField('gab-stage-title', 'Nome da etapa *', h('input', { class: 'input', maxlength: LORE_LIMITS.stage_title, value: c?.stage_title ?? '' })),
      position: formField('gab-position', 'Ordem', h('input', { class: 'input', type: 'number', min: 0, max: 9999, value: c?.position ?? '' }), 'Vazio = no fim da lista.'),
      text: formField('gab-text', 'Item *', h('input', { class: 'input', maxlength: LORE_LIMITS.text, value: c?.text ?? '' })),
      hint: formField('gab-hint', 'Dica', h('input', { class: 'input', maxlength: LORE_LIMITS.hint, value: c?.hint ?? '' })),
    };
    openForm({ title: c ? 'Editar item do checklist' : 'Novo item do checklist', fields, active: c ? c.active : true, focus: 'text',
      onSave: (v) => app.adapter.saveChecklistItem({ ...(c ? { id: c.id } : {}), ...v }) });
  }

  load();
  return () => { alive = false; };
}
