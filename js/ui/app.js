// Controlador da interface: sessão, dados, estado, roteamento e ações comuns.
// Toda leitura/escrita passa pelo adapter (nunca direto no Supabase).
import { buildIndex, search } from '../core/search.js';
import { filterRules } from '../core/rules.js';
import { debounce, h, icon, toast } from './dom.js';
import { createRouter } from './router.js';
import { renderSidebar, renderUser } from './views/layout.js';
import { renderLoading, renderLogin, renderLoginError, renderRestricted } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderProcedurePage } from './views/procedure.js';
import { renderForm } from './views/form.js';
import { renderHistory } from './views/history.js';
import { renderAdmin } from './views/admin.js';
import { renderStaff } from './views/staff.js';
import { renderMember } from './views/member.js';
import { renderProposal, renderProposals } from './views/proposals.js';
import { renderEvaluation, renderEvaluations } from './views/evaluations.js';
import { renderAnnouncements } from './views/announcements.js';
import { renderAudit } from './views/audit.js';
import { renderPanel } from './views/panel.js';
import { isAnnouncementFor } from '../core/workflow.js';
import { renderMarkdownInto } from '../core/render-md.js';
import { openDialog } from './modal.js';
import { renderPermissions } from './views/permissions.js';
import { renderMessage } from './views/message.js';
import { renderAlForm } from './views/allowlist.js';
import { renderAlDetail, renderAlHistory } from './views/al-history.js';
import { renderWebhooks } from './views/webhooks.js';
import { renderGabarito } from './views/gabarito.js';
import { renderLoreNames } from './views/lore-names.js';
import { renderCharacter, renderCharacters } from './views/characters.js';
import { renderProductivity } from './views/productivity.js';
import { renderRules } from './views/rules.js';
import { renderAgenda } from './views/agenda.js';
import { renderArea, renderAreas } from './views/areas.js';
import { renderAreasAdmin } from './views/areas-admin.js';
import { renderPerfil } from './views/perfil.js';
import { renderDiretoria } from './views/diretoria.js';

const SEARCH_DEBOUNCE_MS = 150;
const EMPTY_FILTERS = Object.freeze({ category: '', audience: '', status: '', favoritesOnly: false });

export function createApp(adapter, { isMock = false } = {}) {
  const $ = (id) => document.getElementById(id);
  const els = {
    main: $('main'), sidebar: $('sidebar'), user: $('user-slot'),
    search: $('search-input'), connection: $('connection'),
  };

  const state = {
    session: null,
    staff: null,
    procedures: [],
    index: [],
    rules: [],
    favorites: new Set(),
    online: navigator.onLine,
    query: '',
    filters: { ...EMPTY_FILTERS },
    prefillTitle: '',
    ready: false,
    // Etapas 2B, 3 e 11: contadores do menu e avisos visíveis para quem está logado.
    counts: { proposals: 0, evaluations: 0, announcements: 0, noAreas: 0 },
    announcements: [],
  };
  const shownUrgent = new Set();

  let viewCleanup = null;
  let authToken = 0;
  const router = createRouter((route) => showRoute(route, { navigated: true }));

  const app = {
    adapter, state, router, els, isMock,

    /**
     * Permissões na interface, pelo código do catálogo (js/core/permissions.js),
     * ex.: app.can('procedimentos.arquivar'). O banco/adapter aplica de verdade.
     */
    can(permission) {
      return Boolean(state.staff?.permissions?.includes(permission));
    },

    /** O banco já tem este módulo? ('aprovacao', 'avaliacoes', 'avisos', 'auditoria') */
    feature(name) {
      return Boolean(state.staff?.features?.includes(name));
    },

    /** Etapa 2B: sem procedimentos.aprovar, o conteúdo novo ou editado vai para aprovação. */
    needsApproval() {
      return app.feature('aprovacao') && app.can('procedimentos.editar') && !app.can('procedimentos.aprovar');
    },

    /** Etapa 2B: voltar conteúdo antigo (histórico) também exige procedimentos.aprovar. */
    canRestoreRevision() {
      return app.can('procedimentos.arquivar') && (!app.feature('aprovacao') || app.can('procedimentos.aprovar'));
    },

    /**
     * Contadores do menu (propostas pendentes, avaliações novas, avisos não lidos) e alertas
     * de avisos importantes e urgentes. Chamado a cada navegação, sem travar a tela.
     */
    async refreshCounts() {
      const token = authToken;
      const me = state.staff?.discord_id;
      const counts = { proposals: 0, evaluations: 0, announcements: 0, noAreas: 0 };
      let announcements = state.announcements;
      await Promise.all([
        app.feature('aprovacao') && app.can('procedimentos.aprovar') && adapter.listProposals().then((r) => {
          if (!r.error) counts.proposals = r.data.filter((p) => p.status === 'pendente').length;
        }),
        app.feature('avaliacoes') && app.can('avaliacoes.ler') && adapter.listEvaluations().then((r) => {
          if (!r.error) counts.evaluations = r.data.filter((e) => e.status === 'enviada' && !e.read_at && e.evaluator_id !== me).length;
        }),
        app.feature('areas') && adapter.listMyAreas().then((r) => {
          if (!r.error) counts.noAreas = r.data.length === 0 ? 1 : 0;
        }),
        app.feature('avisos') && adapter.listAnnouncements().then((r) => {
          if (!r.error) announcements = r.data.filter((a) => isAnnouncementFor(a, state.staff));
        }),
      ].filter(Boolean));
      if (token !== authToken || !state.staff) return;
      counts.announcements = announcements.filter((a) => !a.my_read_at).length;
      const changed = JSON.stringify(counts) !== JSON.stringify(state.counts);
      state.counts = counts;
      state.announcements = announcements;
      if (changed) { renderUser(app); renderSidebar(app); }
      renderAnnouncementAlerts();
    },

    /** Marca um aviso como lido (e "Li e entendi") e atualiza faixa e contador. */
    async readAnnouncement(id, { ack = false } = {}) {
      const r = await adapter.markAnnouncementRead(id, { ack });
      if (r.error) { reportError(r.error, 'Não foi possível marcar o aviso como lido.'); return false; }
      await app.refreshCounts();
      return true;
    },

    bySlug: (slug) => state.procedures.find((p) => p.slug === slug) ?? null,
    isFav: (proc) => state.favorites.has(proc.id),
    hasFilters: () => Object.entries(state.filters).some(([k, v]) => v !== EMPTY_FILTERS[k]),

    /** Resultados da busca atual (termo + filtros). */
    results() {
      return search(state.index, state.query, {
        ...state.filters,
        favorites: new Set(state.procedures.filter((p) => state.favorites.has(p.id)).map((p) => p.slug)),
      }).map((r) => r.proc);
    },

    /** Quem pode abrir o Livro de Regras (mesma regra da tela #/regras). */
    canReadRules() {
      return app.feature('regras') && (app.can('regras.ler') || app.can('regras.editar'));
    },

    /** Regras que combinam com o termo da busca do topo (só quando há termo). */
    ruleResults() {
      if (!state.query.trim() || !app.canReadRules()) return [];
      return filterRules(state.rules, { query: state.query });
    },

    /** Recarrega procedimentos e favoritos do adapter. */
    async reload() {
      const token = authToken;
      const [procs, favs, staffChanged, rulesRes] = await Promise.all([
        adapter.listProcedures({ includeArchived: true }),
        adapter.listFavorites(),
        app.refreshStaff(),
        app.canReadRules() ? adapter.listRules() : null,
      ]);
      // A busca do topo também procura no Livro de Regras; se falhar, só some a seção de regras.
      state.rules = rulesRes && !rulesRes.error ? rulesRes.data : [];
      app.refreshCounts();
      if (token !== authToken) return false;
      if (procs.error) { reportError(procs.error, 'Não foi possível carregar os procedimentos.'); return false; }
      const before = signature();
      state.procedures = procs.data;
      state.index = buildIndex(procs.data);
      if (!favs.error) state.favorites = new Set(favs.data);
      const changed = signature() !== before || staffChanged;
      if (changed) renderSidebar(app);
      return changed;
    },

    /**
     * Relê o cargo e as permissões de quem está logado: o CEO pode ter mudado a grade ou o
     * cargo da pessoa. Chamado a cada navegação (via reload). Devolve true se algo mudou.
     */
    async refreshStaff() {
      const token = authToken;
      const result = await adapter.getCurrentStaff();
      if (token !== authToken || result.error || !state.staff) return false;
      if (!result.data) { syncAuth(); return false; }
      if (JSON.stringify(result.data) === JSON.stringify(state.staff)) return false;
      state.staff = result.data;
      renderUser(app);
      renderSidebar(app);
      return true;
    },

    /** Re-renderiza a rota atual mantendo rolagem e foco (após mudança de dados). */
    render() {
      const route = router.route;
      if (!state.ready || ['new', 'edit', 'permissions', 'evaluation', 'evaluations', 'announcements', 'proposal', 'alForm', 'interview', 'alHistory', 'alDetail', 'webhooks', 'gabarito', 'loreNames', 'characters', 'character', 'productivity', 'rules', 'agenda', 'areas', 'areasAdmin', 'area', 'perfil', 'diretoria'].includes(route.name)) return;
      const key = document.activeElement?.dataset?.focusKey;
      const y = window.scrollY;
      showRoute(route, { navigated: false });
      window.scrollTo(0, y);
      if (key) document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    },

    /** Favoritar com atualização otimista; reverte e avisa se o banco falhar (SPEC 2.5). */
    async toggleFavorite(proc) {
      const had = state.favorites.has(proc.id);
      if (had) state.favorites.delete(proc.id); else state.favorites.add(proc.id);
      app.render();
      const result = had ? await adapter.removeFavorite(proc.id) : await adapter.addFavorite(proc.id);
      if (result.error) {
        if (had) state.favorites.add(proc.id); else state.favorites.delete(proc.id);
        app.render();
        toast('Não foi possível salvar o favorito. A alteração foi desfeita.', 3500);
      }
    },

    setQuery(value) {
      state.query = value;
      if (router.route.name !== 'home') router.go('#/');
      else app.render();
    },

    setFilters(patch) {
      Object.assign(state.filters, patch);
      renderSidebar(app);
      if (router.route.name !== 'home') router.go('#/');
      else app.render();
    },

    clearFilters() {
      state.filters = { ...EMPTY_FILTERS };
      renderSidebar(app);
      app.render();
    },

    /** Mostra um erro do adapter de forma amigável. */
    reportError,

    async signOut() {
      const result = await adapter.signOut();
      if (result.error) reportError(result.error, 'Não foi possível sair. Tente novamente.');
    },

    /** Desabilita/habilita os botões que dependem de conexão. */
    applyOnline() {
      document.body.classList.toggle('is-offline', !state.online);
      els.connection.hidden = state.online;
      for (const el of document.querySelectorAll('[data-requires-online]')) {
        el.disabled = !state.online;
        if (!state.online) el.title = 'Sem conexão'; else el.removeAttribute('title');
      }
    },
  };

  /** Resumo dos dados para saber se algo mudou (ids, versões e favoritos). */
  function signature() {
    return `${state.procedures.map((p) => `${p.id}:${p.version}`).join(',')}|${[...state.favorites].sort().join(',')}`;
  }

  function reportError(error, fallback = 'Algo deu errado.') {
    const messages = {
      NETWORK: 'Sem conexão. As alterações não foram salvas.',
      FORBIDDEN: 'Seu cargo não permite esta ação.',
      UNAUTHORIZED: 'Sua sessão expirou. Entre novamente.',
      NOT_FOUND: 'Não encontrado. Ele pode ter sido arquivado ou renomeado.',
    };
    toast(messages[error?.code] ?? error?.message ?? fallback, 4000);
  }

  /* ---------- avisos: faixa (importante) e janela (urgente) · Etapa 11 ---------- */
  const alertsEl = h('div', { class: 'alerts', id: 'alerts', 'aria-live': 'polite' });
  els.main.closest('.layout').before(alertsEl);

  function renderAnnouncementAlerts() {
    const unread = state.announcements.filter((a) => !a.my_read_at && a.priority !== 'normal');
    alertsEl.replaceChildren(...unread.filter((a) => a.priority === 'importante').map((a) => h('div', { class: 'banner banner--warn alert-banner', dataset: { announcementId: a.id } },
      icon('alert-triangle'),
      h('p', {}, h('strong', {}, '⚠ Aviso importante: '), a.title),
      h('div', { class: 'banner-actions' },
        h('a', { class: 'btn btn--sm', href: `#/avisos#aviso-${a.id}` }, 'Abrir'),
        h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: () => app.readAnnouncement(a.id) }, 'Marcar como lido')))));
    const urgent = unread.find((a) => a.priority === 'urgente' && !shownUrgent.has(a.id));
    if (urgent && !document.querySelector('dialog[open]')) showUrgent(urgent);
  }

  async function showUrgent(a) {
    shownUrgent.add(a.id);
    const choice = await openDialog({
      title: `⚠ ${a.title}`,
      body: h('div', { class: 'urgent-body' },
        renderMarkdownInto(h('div', { class: 'md' }), a.body || ''),
        h('p', { class: 'dialog-hint' }, `Aviso urgente de ${a.created_by_name ?? 'Direção'}.`)),
      actions: [
        { label: 'Ver depois', value: 'later', variant: 'ghost' },
        { label: a.requires_ack ? 'Li e entendi' : 'Marcar como lido', value: 'read', variant: 'primary', autofocus: true },
      ],
    });
    if (choice === 'read') await app.readAnnouncement(a.id, { ack: a.requires_ack });
  }

  /* ---------- rotas ---------- */
  function showRoute(route, { navigated }) {
    if (!state.ready) return;
    viewCleanup?.();
    viewCleanup = null;
    const views = {
      home: () => renderHome(app),
      procedure: () => renderProcedurePage(app, route.slug),
      new: () => renderForm(app, {}),
      edit: () => renderForm(app, { slug: route.slug }),
      history: () => renderHistory(app, route.slug),
      admin: () => renderAdmin(app),
      staff: () => renderStaff(app),
      proposals: () => renderProposals(app),
      proposal: () => renderProposal(app, route.slug),
      evaluations: () => renderEvaluations(app),
      evaluation: () => renderEvaluation(app, route.slug),
      announcements: () => renderAnnouncements(app),
      audit: () => renderAudit(app),
      panel: () => renderPanel(app),
      member: () => renderMember(app, route.slug),
      permissions: () => renderPermissions(app),
      alForm: () => renderAlForm(app, 'allowlist', route.slug ?? null),
      interview: () => renderAlForm(app, 'entrevista', route.slug ?? null),
      alHistory: () => renderAlHistory(app),
      alDetail: () => renderAlDetail(app, route.slug),
      webhooks: () => renderWebhooks(app),
      gabarito: () => renderGabarito(app),
      loreNames: () => renderLoreNames(app),
      characters: () => renderCharacters(app),
      character: () => renderCharacter(app, route.slug),
      productivity: () => renderProductivity(app),
      rules: () => renderRules(app, route.slug ?? null),
      agenda: () => renderAgenda(app),
      areas: () => renderAreas(app),
      areasAdmin: () => renderAreasAdmin(app),
      area: () => renderArea(app, route.slug),
      perfil: () => renderPerfil(app, route.slug ?? null),
      diretoria: () => renderDiretoria(app, route.slug ?? null),
      notfound: () => renderMessage(app, { title: 'Página não encontrada', text: 'Volte para a lista de procedimentos.' }),
    };
    const mount = () => {
      document.body.dataset.route = route.name;
      markNavLinks(route.hash);
      viewCleanup = views[route.name]?.() ?? null;
      if (typeof viewCleanup !== 'function') viewCleanup = null;
      app.applyOnline();
      if (navigated) {
        window.scrollTo(0, 0);
        els.main.querySelector('h1')?.focus({ preventScroll: true });
      }
    };

    if (!navigated) { mount(); return; }

    // Ao navegar, busca dados novos (outra pessoa pode ter editado).
    // A edição precisa da versão mais recente ANTES de montar o formulário;
    // as outras telas aparecem na hora e se atualizam se algo mudou.
    const hash = route.hash;
    if (route.name === 'edit') {
      renderLoading(app);
      app.reload().then(() => { if (state.ready && router.route.hash === hash) mount(); });
      return;
    }
    mount();
    if (route.name !== 'new') {
      app.reload().then((changed) => { if (changed && router.route.hash === hash) app.render(); });
    }
  }

  /** Destaca, na barra lateral, o link da página atual (ex.: Equipe). */
  function markNavLinks(hash) {
    for (const a of els.sidebar.querySelectorAll('a[data-nav]')) a.setAttribute('aria-current', String(a.getAttribute('href') === hash));
  }

  /** Apaga da memória e da tela tudo que veio do banco (ao sair ou sem acesso). */
  function clearData() {
    viewCleanup?.();
    viewCleanup = null;
    state.procedures = [];
    state.index = [];
    state.favorites = new Set();
    state.staff = null;
    state.counts = { proposals: 0, evaluations: 0, announcements: 0 };
    state.announcements = [];
    alertsEl.replaceChildren();
    state.query = '';
    state.filters = { ...EMPTY_FILTERS };
    els.search.value = '';
    els.sidebar.replaceChildren();
    els.user.replaceChildren();
  }

  /* ---------- sessão ---------- */
  async function syncAuth() {
    const token = ++authToken;
    state.ready = false;
    clearData();
    document.body.dataset.state = 'loading';
    renderLoading(app);

    const session = await adapter.getSession();
    if (token !== authToken) return;
    state.session = session.data ?? null;

    if (!state.session) {
      state.staff = null;
      document.body.dataset.state = 'auth';
      renderLogin(app);
      return;
    }

    const staff = await adapter.getCurrentStaff();
    if (token !== authToken) return;
    if (staff.error) {
      document.body.dataset.state = 'auth';
      console.error('[Central] Falha ao consultar o cadastro na staff:', staff.error);
      renderLoginError(app, staff.error, () => syncAuth());
      return;
    }
    if (!staff.data) {
      state.staff = null;
      document.body.dataset.state = 'auth';
      renderRestricted(app);
      return;
    }

    state.staff = staff.data;
    renderUser(app);
    await app.reload();
    if (token !== authToken) return;
    state.ready = true;
    document.body.dataset.state = 'app';
    showRoute(router.route, { navigated: false });
  }

  /* ---------- busca e atalhos ---------- */
  function bindSearch() {
    const apply = debounce((value) => app.setQuery(value), SEARCH_DEBOUNCE_MS);
    els.search.addEventListener('input', () => apply(els.search.value));

    document.addEventListener('keydown', (e) => {
      if (document.body.dataset.state !== 'app') return;
      if (document.querySelector('dialog[open]')) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = target?.closest('input, textarea, select, [contenteditable]');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        els.search.focus();
        els.search.select();
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        els.search.focus();
      } else if (e.key === 'Escape' && target === els.search) {
        apply.cancel();
        els.search.value = '';
        app.setQuery('');
      }
    });
  }

  /* ---------- conexão ---------- */
  function bindConnection() {
    const update = () => {
      state.online = navigator.onLine;
      adapter.mock?.setOffline(!state.online);
      app.applyOnline();
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  return {
    app,
    start() {
      bindSearch();
      bindConnection();
      adapter.onAuthChange((session) => {
        // Ao voltar para a janela (minimizar, Alt+Tab, outra aba) o Supabase reconfere a sessão e avisa
        // "SIGNED_IN" de novo, mesmo sem mudança. Se é a mesma conta e a Central já está aberta, não
        // remonta a tela (apagaria formulário, entrevista e análise em andamento): só relê cargo e permissões.
        const sameUser = state.ready && state.staff && session?.user?.id && session.user.id === state.session?.user?.id;
        if (sameUser) { state.session = session; app.refreshStaff(); return; }
        syncAuth();
      });
      syncAuth();
    },
  };
}
