// Janela "Minhas playlists" (SQL 27): criar, renomear e apagar playlists pessoais e escolher as perguntas
// do gabarito de cada uma. Só mexe na lista da própria pessoa; o gabarito global nunca muda.
// Regras (limites e mensagens) em js/core/playlists.js; leitura e escrita pelo adapter.
import { h, icon, toast } from './dom.js';
import { confirmDialog, openDialog } from './modal.js';
import { PLAYLIST_MAX, PLAYLIST_NAME_MAX, canCreatePlaylist, filterQuestions, validatePlaylistName } from '../core/playlists.js';
import { QUESTION_KINDS } from '../core/allowlist.js';

const errorText = (error) => error?.details?.errors?._ ?? error?.message ?? 'Algo deu errado.';
const countLabel = (n) => `${n} ${n === 1 ? 'pergunta' : 'perguntas'}`;

/**
 * Abre a janela e resolve quando ela é fechada.
 * @param {object} app
 * @param {{ questions: object[], onChange?: () => void }} options  questions = perguntas ativas do gabarito, na ordem
 */
export async function openPlaylistManager(app, { questions, onChange = () => {} }) {
  const adapter = app.adapter;
  let playlists = [];
  let openId = null; // playlist aberta (detalhe); null = lista
  let items = []; // perguntas da playlist aberta, na ordem
  let creating = false;
  let renaming = false;
  const byId = new Map(questions.map((q) => [q.id, q]));

  const message = h('p', { class: 'field-error pl-error', id: 'pl-error', role: 'alert', hidden: true });
  const root = h('div', { class: 'pl-manager', id: 'pl-manager' });
  const fail = (error) => { message.textContent = errorText(error); message.hidden = false; };
  const clearFail = () => { message.hidden = true; };

  async function reload() {
    const res = await adapter.listMyPlaylists();
    if (res.error) { fail(res.error); return false; }
    playlists = res.data;
    return true;
  }
  async function openList() {
    openId = null;
    renaming = false;
    await reload();
    draw();
  }
  async function openOne(id) {
    const res = await adapter.listPlaylistQuestions(id);
    if (res.error) { fail(res.error); return; }
    clearFail();
    openId = id;
    renaming = false;
    items = res.data;
    draw();
  }

  /* ---------- lista ---------- */
  function drawList() {
    const nameIn = h('input', { class: 'input', id: 'pl-new-name', maxlength: PLAYLIST_NAME_MAX, autocomplete: 'off', placeholder: 'Nome da playlist (ex.: Entrevista padrão)', 'aria-label': 'Nome da nova playlist' });
    const create = async () => {
      const v = validatePlaylistName(nameIn.value);
      if (!v.valid) { fail({ message: v.error }); nameIn.focus(); return; }
      const res = await adapter.createPlaylist(v.name);
      if (res.error) { fail(res.error); return; }
      clearFail();
      creating = false;
      onChange();
      toast('✓ Playlist criada.');
      await reload();
      await openOne(res.data.id);
    };
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    const full = !canCreatePlaylist(playlists.length);
    return [
      h('div', { class: 'pl-head' },
        h('p', { class: 'panel-text', id: 'pl-count' }, `${playlists.length} de ${PLAYLIST_MAX} playlists`),
        h('button', { type: 'button', class: 'btn btn--sm btn--primary', id: 'pl-new', disabled: full, title: full ? `Você já tem ${PLAYLIST_MAX} playlists.` : null,
          onclick: () => { creating = true; clearFail(); draw(); document.getElementById('pl-new-name')?.focus(); } }, icon('plus'), 'Nova playlist')),
      creating && h('div', { class: 'pl-new-row' }, nameIn,
        h('button', { type: 'button', class: 'btn btn--sm btn--primary', id: 'pl-create', onclick: create }, 'Criar'),
        h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: () => { creating = false; clearFail(); draw(); } }, 'Cancelar')),
      playlists.length
        ? h('ul', { class: 'pl-list', id: 'pl-list' }, playlists.map((p) => h('li', { class: 'pl-row', dataset: { id: p.id } },
          h('button', { type: 'button', class: 'pl-open', onclick: () => openOne(p.id) },
            h('strong', {}, p.nome), h('span', { class: 'field-hint' }, countLabel(p.total))),
          h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-label': `Apagar a playlist ${p.nome}`, onclick: () => remove(p) }, icon('trash')))))
        : !creating && h('p', { class: 'panel-text', id: 'pl-empty' }, 'Você ainda não tem playlists. Crie uma e escolha as perguntas do gabarito que você mais usa.'),
    ];
  }

  async function remove(p) {
    const go = await confirmDialog({
      title: 'Apagar a playlist?', message: `A playlist "${p.nome}" será apagada. As perguntas continuam no gabarito.`, confirmLabel: 'Apagar', danger: true,
    });
    if (!go) return;
    const res = await adapter.deletePlaylist(p.id);
    if (res.error) { fail(res.error); return; }
    clearFail();
    onChange();
    toast('Playlist apagada.');
    await openList();
  }

  /* ---------- detalhe ---------- */
  function drawOne() {
    const p = playlists.find((x) => x.id === openId);
    if (!p) { openList(); return []; }
    const nameIn = h('input', { class: 'input', id: 'pl-rename-input', value: p.nome, maxlength: PLAYLIST_NAME_MAX, autocomplete: 'off', 'aria-label': 'Novo nome da playlist' });
    const save = async () => {
      const v = validatePlaylistName(nameIn.value);
      if (!v.valid) { fail({ message: v.error }); return; }
      const res = await adapter.renamePlaylist(p.id, v.name);
      if (res.error) { fail(res.error); return; }
      clearFail();
      p.nome = v.name;
      renaming = false;
      onChange();
      draw();
    };
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    return [
      h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'pl-back', onclick: openList }, icon('arrow-left'), 'Todas as playlists'),
      renaming
        ? h('div', { class: 'pl-new-row' }, nameIn,
          h('button', { type: 'button', class: 'btn btn--sm btn--primary', id: 'pl-rename-save', onclick: save }, 'Salvar'),
          h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: () => { renaming = false; clearFail(); draw(); } }, 'Cancelar'))
        : h('div', { class: 'pl-head' },
          h('h3', { class: 'pl-title', id: 'pl-title' }, p.nome),
          h('button', { type: 'button', class: 'btn btn--sm', id: 'pl-rename', onclick: () => { renaming = true; clearFail(); draw(); document.getElementById('pl-rename-input')?.focus(); } }, icon('pencil'), 'Renomear')),
      h('div', { class: 'pl-head' },
        h('p', { class: 'panel-text', id: 'pl-items-count' }, countLabel(items.length)),
        h('button', { type: 'button', class: 'btn btn--sm btn--primary', id: 'pl-add', onclick: () => pick(p) }, icon('list-check'), 'Adicionar ou tirar perguntas')),
      items.length
        ? h('ol', { class: 'pl-items', id: 'pl-items' }, items.map((q) => h('li', { class: 'pl-item', dataset: { questionId: q.id } },
          h('span', { class: `al-kind al-kind--${q.kind}` }, QUESTION_KINDS[q.kind] ?? q.kind),
          h('span', { class: 'pl-item-text' }, q.question),
          h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-label': `Tirar da playlist: ${q.question}`, onclick: () => take(p, q) }, icon('x')))))
        : h('p', { class: 'panel-text', id: 'pl-items-empty' }, 'Nenhuma pergunta nesta playlist ainda.'),
    ];
  }

  async function take(p, q) {
    const res = await adapter.removeQuestionFromPlaylist(p.id, q.id);
    if (res.error) { fail(res.error); return; }
    clearFail();
    items = items.filter((x) => x.id !== q.id);
    p.total = items.length;
    onChange();
    draw();
  }

  /** Seletor com todas as perguntas do gabarito: busca por texto, filtro por seção e caixinhas. */
  async function pick(p) {
    const chosen = new Set(items.map((q) => q.id));
    const sections = [...new Set(questions.map((q) => q.section))];
    const state = { query: '', section: '' };
    const list = h('ul', { class: 'pl-pick-list', id: 'pl-pick-list' });
    const counter = h('p', { class: 'field-hint', id: 'pl-pick-count', 'aria-live': 'polite' });
    const drawPick = () => {
      const shown = filterQuestions(questions, state);
      list.replaceChildren(...shown.map((q) => h('li', {}, h('label', { class: 'pl-pick-row' },
        h('input', { type: 'checkbox', checked: chosen.has(q.id), onchange: (e) => { if (e.target.checked) chosen.add(q.id); else chosen.delete(q.id); counter.textContent = `${chosen.size} selecionadas`; } }),
        h('span', { class: `al-kind al-kind--${q.kind}` }, QUESTION_KINDS[q.kind] ?? q.kind),
        h('span', { class: 'pl-item-text' }, q.question)))));
      if (!shown.length) list.replaceChildren(h('li', { class: 'panel-text' }, 'Nenhuma pergunta encontrada.'));
      counter.textContent = `${chosen.size} selecionadas`;
    };
    const search = h('input', { type: 'search', class: 'input', id: 'pl-pick-search', placeholder: 'Buscar por texto', 'aria-label': 'Buscar pergunta', oninput: (e) => { state.query = e.target.value; drawPick(); } });
    const sectionSel = h('select', { class: 'input', id: 'pl-pick-section', 'aria-label': 'Filtrar por categoria', onchange: (e) => { state.section = e.target.value; drawPick(); } },
      h('option', { value: '' }, 'Todas as categorias'), sections.map((s) => h('option', { value: s }, s)));
    drawPick();
    const go = await openDialog({
      title: `Perguntas de "${p.nome}"`,
      body: h('div', { class: 'pl-pick', id: 'pl-pick' }, h('div', { class: 'pl-pick-filters' }, search, sectionSel), counter, list),
      actions: [{ label: 'Cancelar', value: false, variant: 'ghost' }, { label: 'Salvar seleção', value: true, variant: 'primary', autofocus: true }],
    });
    if (!go) return;
    // Mantém a ordem das que já estavam e põe as novas no fim.
    const ordered = [...items.map((q) => q.id).filter((id) => chosen.has(id)), ...questions.map((q) => q.id).filter((id) => chosen.has(id) && !items.some((q) => q.id === id))];
    const res = await adapter.setPlaylistQuestions(p.id, ordered);
    if (res.error) { fail(res.error); return; }
    clearFail();
    items = ordered.map((id) => byId.get(id)).filter(Boolean);
    p.total = items.length;
    onChange();
    toast('✓ Playlist atualizada.');
    draw();
  }

  function draw() {
    root.replaceChildren(...[openId ? drawOne() : drawList(), message].flat().filter(Boolean));
  }

  const first = await reload();
  if (first) draw(); else root.replaceChildren(message);
  await openDialog({ title: 'Minhas playlists', body: root, actions: [{ label: 'Fechar', value: true, variant: 'primary', autofocus: true }] });
}
