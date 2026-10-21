// Etapa 9 · personagens em uso (documento 02, seções 12.3 e 12.4):
//   #/lore/personagens        lista em cartões com busca (lore.consultar ou lore.gerenciar)
//   #/lore/personagens/novo   cadastro (lore.gerenciar)
//   #/lore/personagens/<id>   ficha: dados, foto, histórico e, só para a Direção, as anotações
// Ao salvar, o banco põe o nome em "Nomes proibidos" (Em uso na cidade); Liberado desativa.
import { h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { formatDate } from '../components.js';
import { normalizeName } from '../../core/allowlist.js';
import { CHARACTER_STATUSES, LORE_LIMITS, NOTE_ABOUT, PHOTO_MIMES, photoError } from '../../core/lore.js';
import { errorText } from './allowlist.js';
import { formField, showFieldErrors } from './gabarito.js';
import { canDestroy, runDestructive } from '../destructive.js';
import { renderMessage } from './message.js';

const denied = (app) => {
  if (app.feature('lore') && (app.can('lore.consultar') || app.can('lore.gerenciar'))) return false;
  renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não consulta os personagens da lore.' });
  return true;
};

const statusBadge = (s) => h('span', { class: `badge ${s === 'ativo' ? 'badge--status' : s === 'liberado' ? 'badge--team' : 'badge--revisar'}` }, CHARACTER_STATUSES[s] ?? s);

function avatar(c, large = false) {
  const cls = `char-photo${large ? ' char-photo--lg' : ''}`;
  const initials = c.character_name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return c.photo_url
    ? h('img', { class: cls, src: c.photo_url, alt: `Foto de ${c.character_name}` })
    : h('div', { class: `${cls} char-photo--empty`, 'aria-hidden': 'true' }, initials);
}

export function renderCharacters(app) {
  if (denied(app)) return null;
  let alive = true;
  let all = [];
  let q = '';
  let status = 'ativos';
  const grid = h('ul', { class: 'char-grid', id: 'char-list' }, h('li', { class: 'staff-empty' }, 'Carregando…'));
  const count = h('p', { class: 'panel-text', id: 'char-count', 'aria-live': 'polite' });

  app.els.main.replaceChildren(h('div', { class: 'main-inner characters-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Personagens em uso'),
      h('p', { class: 'page-sub' }, 'Quem faz RP com cada personagem da lore. O nome de cada personagem cadastrado fica bloqueado na análise de allowlist até ele ser Liberado.'),
      app.can('lore.gerenciar') && h('div', { class: 'page-head-actions' },
        h('a', { class: 'btn btn--primary', id: 'char-new', href: '#/lore/personagens/novo' }, icon('plus'), 'Cadastrar personagem'))),
    h('section', { class: 'panel', 'aria-labelledby': 'char-title' },
      h('h2', { class: 'block-title', id: 'char-title' }, icon('users-group'), 'Personagens'),
      h('div', { class: 'staff-filters' },
        h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Buscar'),
          h('input', { class: 'input input--sm', id: 'char-q', type: 'search', placeholder: 'Personagem, @, Discord ID ou ID da Cidade', oninput: (e) => { q = e.target.value; draw(); } })),
        h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Situação'),
          h('select', { class: 'input input--sm', id: 'char-status', onchange: (e) => { status = e.target.value; draw(); } },
            h('option', { value: 'ativos' }, 'Ativos e inativos'), h('option', { value: '' }, 'Todos'),
            Object.entries(CHARACTER_STATUSES).map(([v, t]) => h('option', { value: v }, t))))),
      count, grid)));

  // Permissão e instalação do SQL 25 conferidas uma vez ao abrir a tela (o banco confere de novo ao remover).
  const removable = canDestroy(app, 'personagens.apagar');
  const removeCharacter = (c) => runDestructive(app, 'character', {
    detail: h('p', {}, h('strong', {}, c.character_name), ` · ${c.discord_name} · ID da Cidade ${c.city_id}`),
    call: (reason) => app.adapter.deleteCharacter(c.id, reason),
    okMessage: `Personagem ${c.character_name} removido.`,
    onDone: () => { all = all.filter((x) => x.id !== c.id); draw(); app.applyOnline(); },
  });

  async function load() {
    const res = await app.adapter.listCharacters();
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar os personagens.'); return; }
    all = res.data;
    draw();
  }

  function draw() {
    const nq = normalizeName(q);
    const rows = all.filter((c) => (status === 'ativos' ? c.status !== 'liberado' : !status || c.status === status)
      && (!nq || normalizeName(`${c.character_name} ${c.discord_name} ${c.discord_id} ${c.city_id}`).includes(nq)));
    count.textContent = `${rows.length} de ${all.length} personagens`;
    grid.replaceChildren(...(rows.length ? rows.map((c) => h('li', { class: 'char-card', dataset: { id: c.id } },
      h('a', { class: 'char-link', href: `#/lore/personagens/${c.id}` },
        avatar(c),
        h('span', { class: 'char-info' },
          h('span', { class: 'char-name' }, c.character_name),
          h('span', { class: 'char-meta' }, `${c.discord_name} · ID da Cidade ${c.city_id}`),
          statusBadge(c.status))),
      removable && h('button', {
        type: 'button', class: 'btn btn--sm btn--ghost btn--danger', dataset: { action: 'remove' }, 'data-requires-online': '',
        'aria-label': `Remover o personagem ${c.character_name}`, onclick: () => removeCharacter(c),
      }, icon('trash'), 'Remover')))
      : [h('li', { class: 'staff-empty' }, all.length ? 'Nenhum personagem encontrado.' : 'Nenhum personagem cadastrado ainda.')]));
  }

  load();
  return () => { alive = false; };
}

export function renderCharacter(app, id) {
  if (denied(app)) return null;
  const creating = id === 'novo';
  if (creating && !app.can('lore.gerenciar')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Só a equipe de Lore, o Head Staff e a Direção cadastram personagens.' });
    return null;
  }
  let alive = true;
  const body = h('div', {}, h('p', { class: 'panel-text' }, 'Carregando…'));
  const title = h('h1', { class: 'page-title', tabindex: '-1' }, creating ? 'Cadastrar personagem' : 'Personagem');
  app.els.main.replaceChildren(h('div', { class: 'main-inner character-page' },
    h('a', { class: 'back', href: '#/lore/personagens' }, icon('arrow-left'), 'Personagens em uso'),
    h('header', { class: 'page-head' }, title), body));

  async function load() {
    if (creating) { build(null); return; }
    const res = await app.adapter.getCharacter(id);
    if (!alive) return;
    if (res.error) {
      if (res.error.code === 'NOT_FOUND') renderMessage(app, { title: 'Personagem não encontrado', text: 'Ele pode ter sido removido ou o endereço está errado.' });
      else app.reportError(res.error, 'Não foi possível carregar o personagem.');
      return;
    }
    build(res.data);
  }

  function build(c) {
    const canEdit = app.can('lore.gerenciar');
    if (c) title.textContent = c.character_name;
    const val = (k) => c?.[k] ?? '';
    const input = (k, attrs = {}) => h('input', { class: 'input', value: val(k), maxlength: LORE_LIMITS[k] ?? 20, autocomplete: 'off', disabled: !canEdit, ...attrs });
    const fields = {
      character_name: formField('ch-name', 'Nome do personagem *', input('character_name', { placeholder: 'Nome e sobrenome' })),
      discord_name: formField('ch-discord-name', 'Nome do Discord *', input('discord_name', { placeholder: '@player' })),
      discord_id: formField('ch-discord-id', 'ID do Discord *', input('discord_id', { inputmode: 'numeric', maxlength: 20 }), 'Só números, 17 a 20 dígitos.'),
      city_id: formField('ch-city-id', 'ID da Cidade *', input('city_id', { inputmode: 'numeric', maxlength: 10 }), 'Só números. Não se repete entre os personagens não liberados.'),
      status: formField('ch-status', 'Situação *', h('select', { class: 'input', disabled: !canEdit },
        Object.entries(CHARACTER_STATUSES).map(([v, t]) => h('option', { value: v, selected: (c?.status ?? 'ativo') === v }, t))), 'Liberado = o nome fica livre de novo.'),
    };
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'panel staff-form', id: 'char-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon('id-badge-2'), 'Dados'),
      h('div', { class: 'staff-form-grid' }, Object.values(fields).map((f) => f.el)),
      c && h('p', { class: 'panel-text' }, `Cadastrado por ${c.created_by_name ?? c.created_by} em ${formatDate(c.created_at, { time: true })}`,
        c.version > 1 ? ` · alterado por ${c.updated_by_name ?? c.updated_by} em ${formatDate(c.updated_at, { time: true })}` : ''),
      general,
      (canEdit || (c && canDestroy(app, 'personagens.apagar'))) && h('div', { class: 'form-actions' },
        canEdit && h('button', { type: 'submit', class: 'btn btn--primary', id: 'char-save', 'data-requires-online': '' }, icon('device-floppy'), creating ? 'Cadastrar' : 'Salvar'),
        c && canDestroy(app, 'personagens.apagar') && h('button', {
          type: 'button', class: 'btn btn--ghost btn--danger', id: 'char-remove', 'data-requires-online': '',
          onclick: () => runDestructive(app, 'character', {
            detail: h('p', {}, h('strong', {}, c.character_name), ` · ${c.discord_name} · ID da Cidade ${c.city_id}`),
            call: (reason) => app.adapter.deleteCharacter(c.id, reason),
            okMessage: `Personagem ${c.character_name} removido.`,
            onDone: () => app.router.go('#/lore/personagens'),
          }),
        }, icon('trash'), 'Remover personagem')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.input.value]));
      if (c && values.status === 'liberado' && c.status !== 'liberado' && !await confirmDialog({
        title: 'Liberar o personagem?', message: `O nome "${c.character_name}" deixa de ser bloqueado na análise de allowlist.`, confirmLabel: 'Liberar',
      })) return;
      const res = await app.adapter.saveCharacter({ ...(c ? { id: c.id } : {}), ...values });
      showFieldErrors(fields, general, res.error);
      if (res.error) return;
      toast(creating ? 'Personagem cadastrado. O nome já está bloqueado na allowlist.' : 'Personagem atualizado.');
      if (creating) app.router.go(`#/lore/personagens/${res.data.id}`); else load();
    });

    const sections = [form];
    if (c) sections.push(photoPanel(c, canEdit), revisionsPanel(c));
    if (c && app.can('lore.anotacoes')) sections.push(notesPanel(c));
    body.replaceChildren(...sections);
    app.applyOnline();
    if (creating) fields.character_name.input.focus();
  }

  function photoPanel(c, canEdit) {
    const err = h('p', { class: 'field-error', id: 'char-photo-err', role: 'alert', hidden: true });
    const file = h('input', { type: 'file', id: 'char-photo-file', accept: PHOTO_MIMES.join(','), class: 'sr-only' });
    const send = async (f) => {
      err.hidden = true;
      const bad = f && photoError(f);
      if (bad) { err.textContent = bad; err.hidden = false; return; }
      const res = await app.adapter.setCharacterPhoto(c.id, f);
      if (res.error) { err.textContent = errorText(res.error); err.hidden = false; return; }
      toast(f ? 'Foto salva.' : 'Foto removida.');
      load();
    };
    file.addEventListener('change', () => file.files[0] && send(file.files[0]));
    return h('section', { class: 'panel', 'aria-labelledby': 'char-photo-title' },
      h('h2', { class: 'block-title', id: 'char-photo-title' }, icon('photo'), 'Foto'),
      h('div', { class: 'char-photo-row' }, avatar(c, true),
        canEdit && h('div', { class: 'form-actions' },
          h('label', { class: 'btn', for: 'char-photo-file' }, icon('upload'), c.photo_url ? 'Trocar foto' : 'Enviar foto'), file,
          c.photo_url && h('button', { type: 'button', class: 'btn btn--ghost btn--danger', id: 'char-photo-remove', onclick: () => send(null) }, icon('trash'), 'Tirar foto'))),
      h('p', { class: 'field-hint' }, 'PNG, JPG ou WEBP, até 2 MB. Só a staff logada vê.'), err);
  }

  function revisionsPanel(c) {
    const label = { character_name: 'nome', discord_name: '@', discord_id: 'Discord ID', city_id: 'ID da Cidade', status: 'situação', photo_path: 'foto' };
    const versions = [c, ...c.revisions.map((r) => ({ ...r.data, by: r.changed_by_name ?? r.changed_by, at: r.changed_at }))];
    const items = c.revisions.map((r, i) => {
      const after = versions[i];
      const before = r.data;
      const changes = Object.keys(label).filter((k) => (before[k] ?? null) !== (after[k] ?? null))
        .map((k) => (k === 'photo_path' ? 'foto trocada' : `${label[k]}: ${k === 'status' ? CHARACTER_STATUSES[before[k]] : before[k]} → ${k === 'status' ? CHARACTER_STATUSES[after[k]] : after[k]}`));
      return h('li', { class: 'audit-item' },
        h('span', { class: 'audit-when' }, formatDate(r.changed_at, { time: true })),
        h('span', {}, `${r.changed_by_name ?? r.changed_by}: ${changes.join('; ') || 'sem mudança visível'}`));
    });
    return h('section', { class: 'panel', 'aria-labelledby': 'char-rev-title' },
      h('h2', { class: 'block-title', id: 'char-rev-title' }, icon('history'), 'Histórico de alterações'),
      items.length ? h('ol', { class: 'audit-list', id: 'char-revisions' }, items) : h('p', { class: 'panel-text' }, 'Nenhuma alteração desde o cadastro.'));
  }

  function notesPanel(c) {
    const me = app.state.staff.discord_id;
    const about = h('select', { class: 'input', id: 'note-about' }, Object.entries(NOTE_ABOUT).map(([v, t]) => h('option', { value: v }, t)));
    const text = h('textarea', { class: 'textarea', id: 'note-body', rows: 3, maxlength: LORE_LIMITS.note, placeholder: 'Só a Direção vê este texto.' });
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const add = async () => {
      err.hidden = true;
      const res = await app.adapter.addCharacterNote(c.id, { about: about.value, body: text.value });
      if (res.error) { err.textContent = res.error.details?.errors?.body ?? errorText(res.error); err.hidden = false; return; }
      toast('Anotação salva.');
      load();
    };
    const remove = async (n) => {
      if (!await confirmDialog({ title: 'Apagar a anotação?', message: 'Não dá para desfazer.', confirmLabel: 'Apagar', danger: true })) return;
      const res = await app.adapter.deleteCharacterNote(n.id);
      if (res.error) { app.reportError(res.error); return; }
      load();
    };
    return h('section', { class: 'panel panel--private', 'aria-labelledby': 'char-notes-title' },
      h('h2', { class: 'block-title', id: 'char-notes-title' }, icon('lock'), 'Anotações da administração'),
      h('p', { class: 'panel-text' }, 'Só a Direção vê. Anotações sobre o Player aparecem em todos os personagens do mesmo Discord ID.'),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'note-about' }, 'Sobre'), about),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'note-body' }, 'Anotação'), text, err),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn--primary', id: 'note-add', 'data-requires-online': '', onclick: add }, icon('plus'), 'Adicionar anotação')),
      c.notes.length
        ? h('ul', { class: 'staff-list', id: 'char-notes' }, c.notes.map((n) => h('li', { class: 'staff-row' },
          h('div', { class: 'staff-who' },
            h('p', { class: 'note-body' }, n.body),
            h('p', { class: 'staff-meta' }, `${NOTE_ABOUT[n.about]} · ${n.created_by_name ?? n.created_by} · ${formatDate(n.created_at, { time: true })}`)),
          n.created_by === me && h('div', { class: 'staff-actions' },
            h('button', { type: 'button', class: 'btn btn--sm btn--ghost btn--danger', 'aria-label': 'Apagar anotação', onclick: () => remove(n) }, icon('trash'), 'Apagar')))))
        : h('p', { class: 'panel-text' }, 'Nenhuma anotação.'));
  }

  load();
  return () => { alive = false; };
}
