// Painel de gestão das Áreas (plano 07, Fase 3): #/areas/gerenciar. Só quem tem areas.gerenciar (a RLS do 19_areas.sql é a barreira;
// aqui só some o que não vale). Abas: Áreas, Membros, Tags, Comunicação e Histórico global.
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { formatDate } from '../components.js';
import {
  AREA_MANAGE_ERRORS, AREA_ROLES, AREA_ROLE_LABELS, DEFAULT_AREA_COLOR, DEFAULT_TAG_COLOR, areaSlug, confirmsAreaName, describeAreaEvent,
  levelLabel, levelOptions, moveInOrder,
} from '../../core/areas.js';
import { AREA_DISCORD_ERRORS, AREA_MESSAGE_MAX, areaSendSummary, validateAreaMessage } from '../../core/allowlist.js';
import { ROLE_LABELS, ROLE_LIST } from '../../core/permissions.js';
import { createDraft, attachFormDraft } from '../draft.js';
import { formField, showFieldErrors } from './gabarito.js';
import { colored, errorText, safeColor, safeIcon, unavailable } from './areas.js';

const HISTORY_PAGE = 20;
const TABS = Object.freeze([['areas', 'Áreas'], ['membros', 'Membros'], ['tags', 'Tags'], ['comunicacao', 'Comunicação'], ['historico', 'Histórico']]);
const MESSAGE_TYPES = Object.freeze([
  ['canal', 'Mensagem em canal'], ['dm_equipe', 'DM para a equipe toda'], ['dm_pessoas', 'DM para pessoas específicas'], ['alinhamento', 'Chamar para alinhamento'],
]);
const ACTION_FILTER = Object.freeze([
  ['', 'Todas as ações'], ['insert', 'Criou'], ['update', 'Alterou'], ['delete', 'Apagou'],
  ['enviou_canal', 'Enviou mensagem no canal'], ['enviou_dm', 'Enviou mensagem privada'], ['alinhamento', 'Chamou para alinhamento'],
]);

const options = (pairs, value) => pairs.map(([v, t]) => h('option', { value: v, selected: String(value) === String(v) }, t));

export function renderAreasAdmin(app) {
  if (!app.feature('areas')) return unavailable(app);
  if (!app.can('areas.gerenciar')) {
    app.router.go('#/areas');
    return null;
  }
  let alive = true;
  let drawToken = 0;
  const ctx = {
    tab: 'areas', areas: [], staff: [], areaId: '', editingArea: null, editingTag: null,
    hist: { areaId: '', actorId: '', acao: '', from: '', to: '', page: 0 },
    msg: { view: 'enviar', tipo: 'canal', picked: new Set(), canal: null, texto: '', cargo: false, call: '', result: null, sentArea: '', page: 0 },
  };
  let draft = null; // rascunho automático do formulário aberto na aba
  const panel = h('div', { class: 'areas-panel', id: 'aa-panel' });
  const tabs = h('div', { class: 'areas-tabs', role: 'tablist', 'aria-label': 'Seções da gestão' });
  app.els.main.replaceChildren(h('div', { class: 'main-inner areas-page' },
    h('a', { class: 'back', href: '#/areas' }, icon('arrow-left'), 'Minhas Áreas'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Gerenciar Áreas'),
      h('p', { class: 'page-sub' }, 'Crie e organize as áreas da staff, as equipes, as tags e as mensagens no Discord.')),
    tabs, panel));
  panel.append(h('p', { class: 'panel-text' }, 'Carregando…'));

  const selectedArea = () => ctx.areas.find((a) => a.id === ctx.areaId) ?? null;
  const failed = (res, fallback) => {
    if (!res.error) return false;
    app.reportError(res.error, fallback);
    return true;
  };

  async function load() {
    const [areas, staff] = await Promise.all([app.adapter.listAreas(), app.adapter.listStaffNames()]);
    if (!alive) return;
    if (failed(areas, 'Não foi possível carregar as áreas.') || failed(staff, 'Não foi possível carregar a equipe.')) return;
    Object.assign(ctx, { areas: areas.data, staff: staff.data });
    if (!selectedArea()) ctx.areaId = ctx.areas[0]?.id ?? '';
    drawTabs();
    drawPanel();
  }

  async function reloadAreas() {
    const res = await app.adapter.listAreas();
    if (!alive || failed(res, 'Não foi possível carregar as áreas.')) return false;
    ctx.areas = res.data;
    if (!selectedArea()) ctx.areaId = ctx.areas[0]?.id ?? '';
    return true;
  }

  function drawTabs() {
    tabs.replaceChildren(...TABS.map(([key, label]) => h('button', {
      type: 'button', class: 'areas-tab', role: 'tab', id: `aa-tab-${key}`, 'aria-selected': String(ctx.tab === key),
      onclick: () => { ctx.tab = key; ctx.editingArea = null; ctx.editingTag = null; drawTabs(); drawPanel(); },
    }, label)));
  }

  function drawPanel() {
    drawToken += 1;
    draft?.stop();
    draft = null;
    ({ areas: drawAreas, membros: drawMembers, tags: drawTags, comunicacao: drawCommunication, historico: drawHistory })[ctx.tab]();
  }

  /** Select das áreas (Membros, Tags e Comunicação). */
  function areaPicker(onChange) {
    return h('div', { class: 'areas-picker' },
      h('label', { class: 'field-label', for: 'aa-area' }, 'Área'),
      h('select', { class: 'input', id: 'aa-area', onchange: (e) => { ctx.areaId = e.target.value; onChange(); } },
        options(ctx.areas.map((a) => [a.id, a.status === 'ativa' ? a.nome : `${a.nome} (arquivada)`]), ctx.areaId)));
  }
  const noAreas = () => h('p', { class: 'panel-text areas-empty' }, 'Crie uma área primeiro, na aba Áreas.');

  /* ------------------------------------------------------------------ Áreas */
  function drawAreas() {
    if (ctx.editingArea) { drawAreaForm(); return; }
    const ids = ctx.areas.map((a) => a.id);
    const row = (a, i) => {
      const move = (dir) => async () => {
        const next = moveInOrder(ids, a.id, dir);
        if (!next) return;
        const res = await app.adapter.reorderAreas(next);
        if (!alive || failed(res, 'Não foi possível reordenar.')) return;
        if (await reloadAreas()) drawPanel();
      };
      return colored(h('li', { class: 'areas-admin-row', 'data-area': a.slug },
        h('span', { class: 'areas-card-icon' }, icon(safeIcon(a.icone))),
        h('div', { class: 'areas-admin-info' },
          h('div', { class: 'areas-admin-name' }, h('strong', {}, a.nome),
            a.status === 'arquivada' && h('span', { class: 'areas-chip areas-chip--muted', 'data-status': 'arquivada' }, 'Arquivada')),
          a.descricao && h('span', { class: 'areas-card-desc' }, a.descricao),
          h('span', { class: 'areas-card-meta' },
            h('span', {}, levelLabel(a.nivel_minimo, ROLE_LIST)),
            h('span', {}, `${a.membros} ${a.membros === 1 ? 'membro' : 'membros'}`),
            h('span', {}, `${a.procedimentos} ${a.procedimentos === 1 ? 'procedimento' : 'procedimentos'}`),
            h('span', {}, `#/areas/${a.slug}`),
            h('span', {}, a.discord_role_id ? `Cargo no Discord: ${a.discord_role_id}` : 'Sem cargo no Discord'),
            h('span', {}, a.discord_canal_id ? `Canal: ${a.discord_canal_id}` : 'Sem canal padrão'))),
        h('div', { class: 'areas-admin-actions' },
          h('button', { type: 'button', class: 'btn btn--ghost', 'data-act': 'up', 'aria-label': `Subir ${a.nome}`, disabled: i === 0, onclick: move(-1) }, icon('arrow-up')),
          h('button', { type: 'button', class: 'btn btn--ghost', 'data-act': 'down', 'aria-label': `Descer ${a.nome}`, disabled: i === ids.length - 1, onclick: move(1) }, icon('arrow-down')),
          h('button', { type: 'button', class: 'btn', 'data-act': 'edit', onclick: () => { ctx.editingArea = a; drawPanel(); } }, icon('pencil'), 'Editar'),
          h('button', { type: 'button', class: 'btn', 'data-act': 'toggle', onclick: () => toggleStatus(a) },
            icon(a.status === 'ativa' ? 'archive' : 'archive-off'), a.status === 'ativa' ? 'Arquivar' : 'Reativar'),
          h('button', { type: 'button', class: 'btn btn--danger', 'data-act': 'delete', onclick: () => removeArea(a) }, icon('trash'), 'Apagar'))), a.cor);
    };
    panel.replaceChildren(
      h('div', { class: 'areas-toolbar' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'aa-new', onclick: () => { ctx.editingArea = {}; drawPanel(); } }, icon('plus'), 'Nova área')),
      ctx.areas.length
        ? h('ul', { class: 'areas-admin-list', id: 'aa-list' }, ctx.areas.map(row))
        : h('p', { class: 'panel-text areas-empty' }, 'Nenhuma área criada ainda.'));
  }

  async function toggleStatus(a) {
    const status = a.status === 'ativa' ? 'arquivada' : 'ativa';
    const res = await app.adapter.saveArea({ id: a.id, status });
    if (!alive || failed(res, 'Não foi possível mudar a situação da área.')) return;
    toast(status === 'arquivada' ? 'Área arquivada: agora é só leitura.' : 'Área reativada.');
    if (await reloadAreas()) drawPanel();
  }

  async function removeArea(a) {
    const input = h('input', { class: 'input', type: 'text', id: 'aa-confirm-name', autocomplete: 'off', 'aria-label': `Digite ${a.nome} para confirmar` });
    const pending = openDialog({
      title: 'Apagar área',
      body: h('div', { class: 'areas-confirm' },
        h('p', {}, `Apagar a área "${a.nome}" também apaga os procedimentos, as tags e a lista de membros dela. O histórico permanece. Isso não pode ser desfeito.`),
        h('p', {}, 'Para confirmar, digite o nome da área:'), input),
      actions: [{ label: 'Cancelar', value: false, variant: 'ghost', autofocus: true }, { label: 'Apagar', value: true, variant: 'danger' }],
    });
    // A janela já está na página (o openDialog monta de forma síncrona): o botão só liga quando o nome confere.
    const dialogs = document.querySelectorAll('dialog.dialog');
    const confirmBtn = dialogs[dialogs.length - 1]?.querySelector('.btn--danger-solid');
    if (confirmBtn) confirmBtn.disabled = true;
    input.addEventListener('input', () => { if (confirmBtn) confirmBtn.disabled = !confirmsAreaName(a, input.value); });
    const yes = await pending;
    if (!yes || !alive || !confirmsAreaName(a, input.value)) return;
    const res = await app.adapter.deleteArea(a.id);
    if (!alive || failed(res, 'Não foi possível apagar a área.')) return;
    toast('Área apagada.');
    if (await reloadAreas()) drawPanel();
  }

  function drawAreaForm() {
    const a = ctx.editingArea;
    const editing = Boolean(a.id);
    const taken = ctx.areas.map((x) => x.slug);
    let slugTouched = false;
    const slugInput = h('input', { class: 'input', type: 'text', maxlength: 60, value: a.slug ?? '', disabled: editing, autocomplete: 'off' });
    const fields = {
      nome: formField('aa-f-nome', 'Nome *', h('input', {
        class: 'input', type: 'text', maxlength: 80, value: a.nome ?? '',
        oninput: (e) => { if (!editing && !slugTouched) slugInput.value = e.target.value.trim() ? areaSlug(e.target.value, taken) : ''; },
      })),
      slug: formField('aa-f-slug', 'Endereço', slugInput, editing
        ? 'O endereço não muda depois de criada, para os links continuarem valendo.' : 'Gerado do nome; você pode ajustar. Letras minúsculas, números e hifens.'),
      descricao: formField('aa-f-descricao', 'Descrição', h('textarea', { class: 'input textarea', rows: 2, maxlength: 300 }, a.descricao ?? '')),
      icone: formField('aa-f-icone', 'Ícone', h('input', { class: 'input', type: 'text', maxlength: 40, value: a.icone ?? '', placeholder: 'users-group' }),
        'Nome de um ícone Tabler (ex.: users-group, bug, shield-lock, calendar-event).'),
      cor: formField('aa-f-cor', 'Cor', h('input', { class: 'input areas-color', type: 'color', value: safeColor(a.cor ?? DEFAULT_AREA_COLOR) })),
      nivel_minimo: formField('aa-f-nivel', 'Nível mínimo para entrar', h('select', { class: 'input' },
        options(levelOptions(ROLE_LIST).map((o) => [o.value, o.label]), a.nivel_minimo ?? 1)), 'Quem tem este cargo ou um acima pode entrar na área por conta própria.'),
      discord_role_id: formField('aa-f-role', 'ID do cargo ou tag no Discord', h('input', { class: 'input', type: 'text', inputmode: 'numeric', maxlength: 20, value: a.discord_role_id ?? '' }),
        'Opcional. Usado para marcar a equipe da área. Só números (17 a 20 dígitos).'),
      discord_canal_id: formField('aa-f-canal', 'ID do canal padrão no Discord', h('input', { class: 'input', type: 'text', inputmode: 'numeric', maxlength: 20, value: a.discord_canal_id ?? '' }),
        'Opcional. Canal onde as mensagens da área são postadas. Só números (17 a 20 dígitos).'),
    };
    slugInput.addEventListener('input', () => { slugTouched = true; });
    const general = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const save = h('button', { type: 'submit', class: 'btn btn--primary', id: 'aa-save' }, 'Salvar');
    const form = h('form', { class: 'areas-editor', novalidate: true },
      h('h2', { class: 'areas-editor-title' }, editing ? `Editar ${a.nome}` : 'Nova área'),
      Object.values(fields).map((f) => f.el), general,
      h('div', { class: 'areas-editor-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'aa-cancel', onclick: () => { draft?.clear(); ctx.editingArea = null; drawPanel(); } }, 'Cancelar'), save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      const res = await app.adapter.saveArea({
        ...(editing ? { id: a.id } : { slug: fields.slug.input.value }),
        nome: fields.nome.input.value, descricao: fields.descricao.input.value, icone: fields.icone.input.value, cor: fields.cor.input.value,
        nivel_minimo: fields.nivel_minimo.input.value, discord_role_id: fields.discord_role_id.input.value, discord_canal_id: fields.discord_canal_id.input.value,
      });
      save.disabled = false;
      if (!alive) return;
      if (res.error) { showFieldErrors(fields, general, res.error); return; }
      draft?.clear();
      ctx.editingArea = null;
      toast(editing ? 'Área salva.' : 'Área criada.');
      if (await reloadAreas()) drawPanel();
    });
    panel.replaceChildren(form);
    draft = attachFormDraft(app, `area:${a.id ?? 'nova'}`, form, { bannerId: 'aa-draft-banner' });
    fields.nome.input.focus();
  }

  /* ------------------------------------------------------------------ Membros */
  async function drawMembers() {
    if (!ctx.areas.length) { panel.replaceChildren(noAreas()); return; }
    const token = drawToken;
    panel.replaceChildren(areaPicker(drawPanel), h('p', { class: 'panel-text' }, 'Carregando…'));
    const [team, free] = await Promise.all([app.adapter.listAreaTeam(ctx.areaId), app.adapter.listMembersWithoutArea()]);
    if (!alive || token !== drawToken) return;
    if (failed(team, 'Não foi possível carregar a equipe da área.') || failed(free, 'Não foi possível carregar quem está sem área.')) return;
    const area = selectedArea();
    const refresh = async () => { app.refreshCounts(); await reloadAreas(); if (alive) drawPanel(); };

    const roleSelect = (m) => h('select', {
      class: 'input areas-inline-select', 'aria-label': `Papel de ${m.display_name}`,
      onchange: async (e) => {
        const res = await app.adapter.setAreaMemberRole(area.id, m.discord_id, e.target.value);
        if (!alive) return;
        if (res.error) toast(errorText(res.error), 3500); else toast(e.target.value === 'lider' ? `${m.display_name} agora é líder.` : `${m.display_name} agora é membro.`);
        await refresh();
      },
    }, options(AREA_ROLES.map((r) => [r, AREA_ROLE_LABELS[r]]), m.papel));
    const teamRow = (m) => h('li', { class: 'areas-team-row', 'data-discord': m.discord_id },
      h('strong', {}, m.display_name),
      h('span', { class: 'areas-card-desc' }, ROLE_LABELS[m.role] ?? m.role),
      roleSelect(m),
      h('span', { class: 'areas-card-desc' }, `desde ${formatDate(m.entrou_em)}`),
      h('button', {
        type: 'button', class: 'btn btn--danger', 'data-act': 'remove', 'aria-label': `Tirar ${m.display_name} da área`,
        onclick: async () => {
          if (!await confirmDialog({ title: 'Tirar da área', message: `Tirar ${m.display_name} da área ${area.nome}?`, confirmLabel: 'Tirar', danger: true })) return;
          const res = await app.adapter.removeAreaMember(area.id, m.discord_id);
          if (!alive) return;
          if (res.error) toast(errorText(res.error), 3500); else toast(`${m.display_name} saiu da área.`);
          await refresh();
        },
      }, icon('user-minus'), 'Tirar'));

    const candidates = ctx.staff.filter((s) => !team.data.some((m) => m.discord_id === s.discord_id));
    const personSelect = h('select', { class: 'input', id: 'aa-add-person', 'aria-label': 'Pessoa da staff' },
      h('option', { value: '' }, 'Escolha uma pessoa'), options(candidates.map((s) => [s.discord_id, s.display_name]), ''));
    const papelSelect = h('select', { class: 'input', id: 'aa-add-papel', 'aria-label': 'Papel na área' }, options(AREA_ROLES.map((r) => [r, AREA_ROLE_LABELS[r]]), 'membro'));
    const addError = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const add = h('form', { class: 'areas-add', novalidate: true },
      personSelect, papelSelect, h('button', { type: 'submit', class: 'btn btn--primary', id: 'aa-add' }, icon('user-plus'), 'Adicionar'), addError);
    add.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!personSelect.value) { addError.textContent = AREA_MANAGE_ERRORS.member; addError.hidden = false; return; }
      const res = await app.adapter.addAreaMember(area.id, personSelect.value, papelSelect.value);
      if (!alive) return;
      if (res.error) { addError.textContent = errorText(res.error); addError.hidden = false; return; }
      toast('Pessoa adicionada à área.');
      await refresh();
    });

    const freeRow = (m) => {
      const where = h('select', { class: 'input areas-inline-select', 'aria-label': `Área para ${m.display_name}` },
        options(ctx.areas.filter((a) => a.status === 'ativa').map((a) => [a.id, a.nome]), area.id));
      return h('li', { class: 'areas-team-row', 'data-discord': m.discord_id },
        h('strong', {}, m.display_name), h('span', { class: 'areas-card-desc' }, ROLE_LABELS[m.role] ?? m.role), where,
        h('button', {
          type: 'button', class: 'btn', 'data-act': 'assign',
          onclick: async () => {
            const res = await app.adapter.addAreaMember(where.value, m.discord_id, 'membro');
            if (!alive) return;
            if (res.error) toast(errorText(res.error), 3500); else toast(`${m.display_name} entrou na área.`);
            await refresh();
          },
        }, icon('user-plus'), 'Adicionar'));
    };

    panel.replaceChildren(
      areaPicker(drawPanel),
      h('section', { class: 'areas-block' }, h('h2', { class: 'areas-block-title' }, `Equipe de ${area.nome}`),
        team.data.length ? h('ul', { class: 'areas-team', id: 'aa-team' }, team.data.map(teamRow)) : h('p', { class: 'panel-text' }, 'Esta área ainda não tem equipe.'),
        add),
      h('section', { class: 'areas-block' }, h('h2', { class: 'areas-block-title' }, 'Membros sem área'),
        free.data.length
          ? h('ul', { class: 'areas-team', id: 'aa-free' }, free.data.map(freeRow))
          : h('p', { class: 'panel-text', id: 'aa-free-empty' }, 'Todos os membros ativos da staff estão em alguma área.')));
  }

  /* ------------------------------------------------------------------ Tags */
  async function drawTags() {
    if (!ctx.areas.length) { panel.replaceChildren(noAreas()); return; }
    const token = drawToken;
    panel.replaceChildren(areaPicker(() => { ctx.editingTag = null; drawPanel(); }), h('p', { class: 'panel-text' }, 'Carregando…'));
    const res = await app.adapter.listAreaTags(ctx.areaId);
    if (!alive || token !== drawToken || failed(res, 'Não foi possível carregar as tags.')) return;
    const area = selectedArea();
    const t = ctx.editingTag ?? {};
    const fields = {
      nome: formField('aa-t-nome', 'Nome da tag *', h('input', { class: 'input', type: 'text', maxlength: 40, value: t.nome ?? '' })),
      cor: formField('aa-t-cor', 'Cor', h('input', { class: 'input areas-color', type: 'color', value: safeColor(t.cor ?? DEFAULT_TAG_COLOR) })),
      discord_role_id: formField('aa-t-role', 'ID do cargo no Discord', h('input', { class: 'input', type: 'text', inputmode: 'numeric', maxlength: 20, value: t.discord_role_id ?? '' }),
        'Opcional. Só números (17 a 20 dígitos).'),
    };
    const general = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'areas-editor areas-tag-form', novalidate: true },
      h('h2', { class: 'areas-editor-title' }, t.id ? `Editar tag ${t.nome}` : 'Nova tag'),
      Object.values(fields).map((f) => f.el), general,
      h('div', { class: 'areas-editor-actions' },
        t.id && h('button', { type: 'button', class: 'btn btn--ghost', id: 'aa-t-cancel', onclick: () => { draft?.clear(); ctx.editingTag = null; drawPanel(); } }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'aa-t-save' }, 'Salvar tag')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saved = await app.adapter.saveAreaTag(area.id, {
        id: t.id, nome: fields.nome.input.value, cor: fields.cor.input.value, discord_role_id: fields.discord_role_id.input.value,
      });
      if (!alive) return;
      if (saved.error) { showFieldErrors(fields, general, saved.error); return; }
      draft?.clear();
      ctx.editingTag = null;
      toast(t.id ? 'Tag salva.' : 'Tag criada.');
      drawPanel();
    });
    const row = (tag) => h('li', { class: 'areas-team-row', 'data-tag': tag.nome },
      colored(h('span', { class: 'areas-tag' }, tag.nome), tag.cor),
      h('span', { class: 'areas-card-desc' }, tag.discord_role_id ? `Cargo no Discord: ${tag.discord_role_id}` : 'Sem cargo no Discord'),
      h('button', { type: 'button', class: 'btn', 'data-act': 'edit', onclick: () => { ctx.editingTag = tag; drawPanel(); } }, icon('pencil'), 'Editar'),
      h('button', {
        type: 'button', class: 'btn btn--danger', 'data-act': 'delete',
        onclick: async () => {
          if (!await confirmDialog({ title: 'Apagar tag', message: `Apagar a tag "${tag.nome}"? Ela sai dos procedimentos que a usam.`, confirmLabel: 'Apagar', danger: true })) return;
          const done = await app.adapter.deleteAreaTag(tag.id);
          if (!alive) return;
          if (done.error) toast(errorText(done.error), 3500); else toast('Tag apagada.');
          drawPanel();
        },
      }, icon('trash'), 'Apagar'));
    panel.replaceChildren(
      areaPicker(() => { ctx.editingTag = null; drawPanel(); }), form,
      res.data.length ? h('ul', { class: 'areas-team', id: 'aa-tags' }, res.data.map(row)) : h('p', { class: 'panel-text areas-empty' }, 'Esta área ainda não tem tags.'));
    draft = attachFormDraft(app, `area-tag:${area.id}:${t.id ?? 'nova'}`, form, { bannerId: 'aa-t-draft-banner' });
    if (t.id) fields.nome.input.focus();
  }

  /* ------------------------------------------------------------------ Comunicação */
  // Fase 5: envio pela Edge Function (ação 'area'), com janela de confirmação, resultado por pessoa e o transcrito das mensagens enviadas.
  const COMM_VIEWS = Object.freeze([['enviar', 'Enviar mensagem'], ['enviadas', 'Mensagens enviadas']]);
  const TYPE_LABELS = Object.freeze({ canal: 'Canal', dm: 'Privado', alinhamento: 'Alinhamento' });

  function drawCommunication() {
    const views = h('div', { class: 'areas-subtabs', role: 'group', 'aria-label': 'Comunicação' },
      COMM_VIEWS.map(([key, label]) => h('button', {
        type: 'button', class: 'btn areas-subtab', id: `aa-m-view-${key}`, 'aria-pressed': String(ctx.msg.view === key),
        onclick: () => { ctx.msg.view = key; ctx.msg.page = 0; drawPanel(); },
      }, label)));
    if (ctx.msg.view === 'enviadas') return drawSentMessages(views);
    return drawComposer(views);
  }

  async function drawComposer(views) {
    if (!ctx.areas.length) { panel.replaceChildren(views, noAreas()); return; }
    const token = drawToken;
    const clear = () => { ctx.msg.picked.clear(); ctx.msg.canal = null; ctx.msg.result = null; };
    panel.replaceChildren(views, areaPicker(() => { clear(); drawPanel(); }), h('p', { class: 'panel-text' }, 'Carregando…'));
    const team = await app.adapter.listAreaTeam(ctx.areaId);
    if (!alive || token !== drawToken || failed(team, 'Não foi possível carregar a equipe da área.')) return;
    const area = selectedArea();
    const m = ctx.msg;
    const archived = area.status !== 'ativa';
    const usesChannel = m.tipo === 'canal' || m.tipo === 'alinhamento';
    const usesPeople = m.tipo === 'dm_pessoas' || m.tipo === 'alinhamento';
    const counter = h('p', { class: 'field-hint', id: 'aa-m-count', 'aria-live': 'polite' });
    const paint = () => { counter.textContent = `${m.texto.length} de ${AREA_MESSAGE_MAX} caracteres`; };
    const text = h('textarea', { class: 'input textarea', id: 'aa-m-texto', rows: 6, maxlength: AREA_MESSAGE_MAX, oninput: (e) => { m.texto = e.target.value; paint(); } }, m.texto);
    paint();
    const typeField = formField('aa-m-tipo', 'Tipo de envio', h('select', { class: 'input', onchange: (e) => { m.tipo = e.target.value; m.result = null; drawPanel(); } }, options(MESSAGE_TYPES, m.tipo)));
    const channelField = usesChannel && formField('aa-m-canal', 'ID do canal', h('input', {
      class: 'input', type: 'text', inputmode: 'numeric', maxlength: 20, value: m.canal ?? area.discord_canal_id ?? '',
      oninput: (e) => { m.canal = e.target.value; },
    }), 'Vem preenchido com o canal padrão da área; pode trocar para este envio.');
    const people = usesPeople && h('fieldset', { class: 'areas-tagbox', id: 'aa-m-people' },
      h('legend', { class: 'field-label' }, m.tipo === 'dm_pessoas' ? 'Destinatários *' : 'Quem chamar (nenhum marcado = a equipe toda)'),
      team.data.length ? team.data.map((p) => h('label', { class: 'areas-tagpick' },
        h('input', { type: 'checkbox', checked: m.picked.has(p.discord_id), onchange: (e) => { if (e.target.checked) m.picked.add(p.discord_id); else m.picked.delete(p.discord_id); } }),
        ' ', p.display_name)) : h('span', { class: 'panel-text' }, 'Esta área não tem membros.'));
    const roleBox = usesChannel && h('label', { class: 'areas-tagpick' },
      h('input', { type: 'checkbox', id: 'aa-m-cargo', checked: m.cargo && Boolean(area.discord_role_id), disabled: !area.discord_role_id, onchange: (e) => { m.cargo = e.target.checked; } }),
      ' ', area.discord_role_id ? 'Mencionar o cargo da área' : 'Mencionar o cargo da área (cadastre o ID do cargo na aba Áreas)');
    const callField = m.tipo === 'alinhamento' && formField('aa-m-call', 'Link da call (opcional)', h('input', {
      class: 'input', type: 'url', maxlength: 300, value: m.call, placeholder: 'https://discord.gg/...', oninput: (e) => { m.call = e.target.value; },
    }), 'Só links discord.gg ou discord.com/channels.');
    const general = h('p', { class: 'field-error', id: 'aa-m-error', role: 'alert', hidden: true });
    const sendBtn = h('button', { type: 'submit', class: 'btn btn--primary', id: 'aa-m-send', disabled: archived }, icon('send'), 'Enviar');
    const peopleError = h('p', { class: 'field-error', id: 'aa-m-people-err', hidden: true });
    // Mesmo formato do showFieldErrors: chave do erro -> campo com `.error`.
    const fields = {
      conteudo: formField('aa-m-texto-x', '', h('span')),
      canal_id: channelField || { error: h('p', { hidden: true }) },
      link_call: callField || { error: h('p', { hidden: true }) },
      user_ids: { error: peopleError },
    };

    const request = () => ({
      tipo: m.tipo === 'dm_equipe' || m.tipo === 'dm_pessoas' ? 'dm' : m.tipo,
      conteudo: m.texto.trim(),
      canal_id: usesChannel ? String(m.canal ?? area.discord_canal_id ?? '').trim() : '',
      user_ids: usesPeople ? [...m.picked] : [],
      mencionar_cargo: usesChannel && m.cargo && Boolean(area.discord_role_id),
      link_call: m.tipo === 'alinhamento' ? m.call.trim() : '',
    });
    // Rascunho da mensagem: o que será enviado (texto, tipo, canal, marcações), sem o resultado do último envio.
    const EMPTY_MESSAGE = { tipo: 'canal', texto: '', canal: null, cargo: false, call: '', picked: [] };
    draft = createDraft(app, `area-msg:${area.id}`, {
      read: () => ({ tipo: m.tipo, texto: m.texto, canal: m.canal, cargo: m.cargo, call: m.call, picked: [...m.picked] }),
      initial: EMPTY_MESSAGE, hasContent: (v) => Boolean(v.texto?.trim()),
    });
    const draftBanner = draft.banner((v) => {
      Object.assign(m, { tipo: v.tipo, texto: v.texto, canal: v.canal, cargo: v.cargo, call: v.call, result: null });
      m.picked = new Set(v.picked);
      drawPanel();
    }, { id: 'aa-m-draft-banner' });
    const peopleNames = (ids) => ids.map((id) => team.data.find((p) => p.discord_id === id)?.display_name ?? id);

    async function submit(e) {
      e.preventDefault();
      if (sendBtn.disabled) return;
      showFieldErrors(fields, general, null);
      const req = request();
      const local = validateAreaMessage({ kind: req.tipo, conteudo: req.conteudo, canal_id: req.canal_id, user_ids: req.user_ids, link_call: req.link_call });
      if (!local.valid) { showFieldErrors(fields, general, { details: { errors: local.errors } }); return; }
      if (m.tipo === 'dm_pessoas' && !req.user_ids.length) { peopleError.textContent = AREA_DISCORD_ERRORS.noRecipients; peopleError.hidden = false; return; }
      const everyone = req.tipo !== 'canal' && !req.user_ids.length;
      const channel = `no canal ${req.canal_id || area.discord_canal_id || '(sem canal)'}`;
      const target = req.tipo === 'canal' ? channel
        : req.tipo === 'dm' ? (everyone ? `no privado da equipe toda de ${area.nome}` : `no privado de ${req.user_ids.length} ${req.user_ids.length === 1 ? 'pessoa' : 'pessoas'}`)
          : `${channel}, chamando ${everyone ? 'a equipe toda' : peopleNames(req.user_ids).join(', ')}`;
      const yes = await openDialog({
        title: 'Enviar esta mensagem?',
        body: h('div', { class: 'areas-confirm', id: 'aa-m-confirm' },
          h('p', {}, `A mensagem será enviada ${target}${req.mencionar_cargo ? ', marcando o cargo da área' : ''}.`),
          h('pre', { class: 'areas-preview' }, req.conteudo),
          req.link_call && h('p', { class: 'areas-card-desc' }, `Link da call: ${req.link_call}`)),
        actions: [{ label: 'Voltar', value: false, variant: 'ghost', autofocus: true }, { label: 'Enviar', value: true, variant: 'primary' }],
      });
      if (!yes || !alive || token !== drawToken || sendBtn.disabled) return;
      sendBtn.disabled = true;
      sendBtn.textContent = 'Enviando…';
      const res = await app.adapter.sendAreaMessage(area.id, req);
      if (!alive || token !== drawToken) return;
      if (res.error) {
        sendBtn.disabled = false;
        sendBtn.replaceChildren(icon('send'), 'Enviar');
        showFieldErrors(fields, general, res.error);
        return;
      }
      m.texto = '';
      m.result = res.data;
      m.picked.clear();
      draft?.clear();
      toast(areaSendSummary(res.data), 3500);
      drawPanel();
    }

    const result = m.result && h('section', { class: 'areas-result', id: 'aa-m-result', 'aria-live': 'polite' },
      h('p', {}, h('strong', {}, areaSendSummary(m.result))),
      m.result.registrado === false && h('p', { class: 'areas-readonly' }, 'A mensagem foi enviada, mas não foi possível registrar no histórico.'),
      m.result.detalhes?.some((d) => d.status !== 'ok') && h('ul', { class: 'areas-result-fails', id: 'aa-m-fails' },
        m.result.detalhes.filter((d) => d.status !== 'ok').map((d) => h('li', {}, `${d.nome}: ${d.erro || 'falhou'}`))));
    panel.replaceChildren(...[
      views,
      areaPicker(() => { clear(); drawPanel(); }),
      draftBanner,
      archived && h('p', { class: 'panel-text areas-readonly', id: 'aa-m-note' }, 'Esta área está arquivada: reative para enviar mensagens.'),
      result,
      h('form', { class: 'areas-editor', id: 'aa-compose', novalidate: true, onsubmit: submit },
        typeField.el, channelField && channelField.el, people, peopleError,
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'aa-m-texto' }, 'Mensagem *'), text, counter, fields.conteudo.error),
        roleBox, callField && callField.el,
        // Plano 11: chamar UMA pessoa (qualquer membro da staff), com prazo, privado e Agenda, fica no Painel da Diretoria.
        m.tipo === 'alinhamento' && app.feature('alinhamento') && app.can('alinhamento.chamar') && h('p', { class: 'field-hint', id: 'aa-m-align-hint' },
          'Para chamar uma pessoa só, com prazo, privado e reunião na Agenda, use ', h('a', { href: '#/diretoria/alinhamentos' }, 'Painel da Diretoria › Alinhamentos'), '.'),
        general,
        h('div', { class: 'areas-editor-actions' }, sendBtn)),
    ].filter(Boolean));
  }

  async function drawSentMessages(views) {
    const token = drawToken;
    const m = ctx.msg;
    const filter = h('div', { class: 'areas-picker' },
      h('label', { class: 'field-label', for: 'aa-s-area' }, 'Área'),
      h('select', { class: 'input', id: 'aa-s-area', onchange: (e) => { m.sentArea = e.target.value; m.page = 0; drawPanel(); } },
        options([['', 'Todas as áreas'], ...ctx.areas.map((a) => [a.id, a.nome])], m.sentArea)));
    panel.replaceChildren(views, filter, h('p', { class: 'panel-text' }, 'Carregando…'));
    const res = await app.adapter.listAreaMessages(m.sentArea, { limit: HISTORY_PAGE, offset: m.page * HISTORY_PAGE });
    if (!alive || token !== drawToken || failed(res, 'Não foi possível carregar as mensagens enviadas.')) return;
    const { items, total } = res.data;
    const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
    const who = (d) => h('li', { class: d.status === 'ok' ? 'areas-dest areas-dest--ok' : 'areas-dest areas-dest--fail' },
      d.status === 'ok' ? '✓ ' : '✗ ', d.nome ?? d.discord_id, d.erro ? ` (${d.erro})` : '');
    panel.replaceChildren(views, filter,
      items.length
        ? h('ul', { class: 'areas-history', id: 'aa-sent' }, items.map((c) => h('li', { class: 'areas-history-row', 'data-tipo': c.tipo },
          h('p', {}, h('strong', {}, c.enviado_por_nome ?? 'Sistema'), ` · ${TYPE_LABELS[c.tipo] ?? c.tipo}`, c.area_nome ? ` · ${c.area_nome}` : ''),
          h('p', { class: 'areas-card-desc' }, formatDate(c.criado_em, { time: true }), c.canal_id ? ` · canal ${c.canal_id}` : ''),
          h('p', { class: 'areas-message-text' }, c.conteudo),
          c.destinatarios?.length ? h('details', { class: 'areas-diff' }, h('summary', {}, `Destinatários (${c.destinatarios.length})`),
            h('ul', { class: 'areas-dests' }, c.destinatarios.map(who))) : null)))
        : h('p', { class: 'panel-text areas-empty' }, 'Nenhuma mensagem enviada ainda.'),
      h('div', { class: 'areas-pager' },
        h('button', { type: 'button', class: 'btn', id: 'aa-s-prev', disabled: m.page === 0, onclick: () => { m.page -= 1; drawPanel(); } }, 'Mais recentes'),
        h('span', { class: 'areas-card-desc' }, `Página ${m.page + 1} de ${pages}`),
        h('button', { type: 'button', class: 'btn', id: 'aa-s-next', disabled: m.page + 1 >= pages, onclick: () => { m.page += 1; drawPanel(); } }, 'Mais antigos')));
  }

  /* ------------------------------------------------------------------ Histórico global */
  async function drawHistory() {
    const token = drawToken;
    const f = ctx.hist;
    const filter = (key) => (e) => { f[key] = e.target.value; f.page = 0; drawPanel(); };
    const bar = h('div', { class: 'areas-toolbar areas-filters' },
      h('select', { class: 'input', id: 'aa-h-area', 'aria-label': 'Filtrar por área', onchange: filter('areaId') },
        options([['', 'Todas as áreas'], ...ctx.areas.map((a) => [a.id, a.nome])], f.areaId)),
      h('select', { class: 'input', id: 'aa-h-actor', 'aria-label': 'Filtrar por pessoa', onchange: filter('actorId') },
        options([['', 'Todas as pessoas'], ...ctx.staff.map((s) => [s.discord_id, s.display_name])], f.actorId)),
      h('select', { class: 'input', id: 'aa-h-acao', 'aria-label': 'Filtrar por ação', onchange: filter('acao') }, options(ACTION_FILTER, f.acao)),
      h('input', { class: 'input', type: 'date', id: 'aa-h-from', 'aria-label': 'De', value: f.from, onchange: filter('from') }),
      h('input', { class: 'input', type: 'date', id: 'aa-h-to', 'aria-label': 'Até', value: f.to, onchange: filter('to') }));
    panel.replaceChildren(bar, h('p', { class: 'panel-text' }, 'Carregando…'));
    const res = await app.adapter.listAllAreaHistory({ ...f, limit: HISTORY_PAGE, offset: f.page * HISTORY_PAGE });
    if (!alive || token !== drawToken || failed(res, 'Não foi possível carregar o histórico.')) return;
    const { items, total } = res.data;
    const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
    const diff = (e) => {
      const json = JSON.stringify(e.detalhes ?? {}, null, 2);
      return h('details', { class: 'areas-diff' }, h('summary', {}, 'Ver detalhes'), h('pre', {}, json.length > 4000 ? `${json.slice(0, 4000)}\n…` : json));
    };
    panel.replaceChildren(bar,
      items.length
        ? h('ul', { class: 'areas-history', id: 'aa-history' }, items.map((e) => h('li', { class: 'areas-history-row' },
          h('p', {}, h('strong', {}, e.ator_nome ?? 'Sistema'), ` ${describeAreaEvent(e)}`, e.area_nome && e.entidade !== 'areas' ? ` · ${e.area_nome}` : ''),
          h('p', { class: 'areas-card-desc' }, formatDate(e.criado_em, { time: true })), diff(e))))
        : h('p', { class: 'panel-text areas-empty' }, 'Nenhum registro com esses filtros.'),
      h('div', { class: 'areas-pager' },
        h('button', { type: 'button', class: 'btn', id: 'aa-h-prev', disabled: f.page === 0, onclick: () => { f.page -= 1; drawPanel(); } }, 'Mais recentes'),
        h('span', { class: 'areas-card-desc' }, `Página ${f.page + 1} de ${pages}`),
        h('button', { type: 'button', class: 'btn', id: 'aa-h-next', disabled: f.page + 1 >= pages, onclick: () => { f.page += 1; drawPanel(); } }, 'Mais antigos')));
  }

  load();
  return () => { alive = false; draft?.stop(); };
}
