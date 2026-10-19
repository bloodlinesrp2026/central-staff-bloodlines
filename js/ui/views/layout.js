// Topo (usuário logado) e barra lateral (grupos do menu).
import { h, icon } from '../dom.js';
import { roleLabel } from '../../core/permissions.js';
import { CATEGORIES } from '../../core/validate.js';

export function renderUser(app) {
  const { staff, session } = app.state;
  const name = staff?.display_name ?? session?.user?.name ?? '';
  const initials = name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const avatar = session?.user?.avatar_url
    ? h('img', { class: 'avatar', src: session.user.avatar_url, alt: '', width: 34, height: 34, referrerpolicy: 'no-referrer' })
    : h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials);

  const unread = app.state.counts?.announcements ?? 0;
  const pending = (app.state.counts?.proposals ?? 0) + (app.state.counts?.evaluations ?? 0);

  // replaceChildren escreveria "false" como texto: o filter tira os itens condicionais ausentes.
  app.els.user.replaceChildren(...[
    avatar,
    h('div', { class: 'user-info' },
      h('span', { class: 'user-name' }, name),
      h('span', { class: `role-badge role-badge--${staff?.role}` }, roleLabel(staff?.role))),
    app.feature('perfil') && h('a', {
      class: 'icon-btn', href: '#/perfil', id: 'nav-perfil', 'aria-label': 'Meu perfil', title: 'Meu perfil',
    }, icon('user-circle')),
    app.feature('avisos') && h('a', {
      class: 'icon-btn icon-btn--count', href: '#/avisos', id: 'nav-announcements',
      'aria-label': unread ? `Avisos (${unread} não lidos)` : 'Avisos', title: 'Avisos',
    }, icon('bell'), unread > 0 && h('span', { class: 'count-dot', 'aria-hidden': 'true' }, String(unread))),
    // Só no celular: a barra lateral some e o Início é o caminho para todo o resto.
    h('a', {
      class: 'icon-btn icon-btn--count only-mobile', href: '#/painel', id: 'nav-panel', 'aria-label': 'Início e menu', title: 'Início e menu',
    }, icon('layout-grid'), pending > 0 && h('span', { class: 'count-dot', 'aria-hidden': 'true' }, String(pending))),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Sair', title: 'Sair', onclick: () => app.signOut() },
      icon('logout')),
  ].filter(Boolean));
}

/**
 * Mapa único do menu: a barra lateral e a tela Início (#/painel) leem esta lista, então
 * nunca divergem. Cinco grupos, pela pergunta "o que eu quero fazer?":
 * Início, Consulta, Trabalho, Equipe e Configuração. Cada módulo só aparece quando o banco
 * já tem o SQL dele (app.feature) e a pessoa tem a permissão (app.can).
 */
export function navGroups(app) {
  const c = app.state.counts ?? {};
  const evaluations = app.can('avaliacoes.criar') || app.can('avaliacoes.ler') || app.can('avaliacoes.gerenciar');
  const lore = app.feature('allowlist') && (app.can('lore.consultar') || app.can('lore.gerenciar'));
  const groups = [
    {
      id: 'inicio', title: 'Início',
      items: [
        { href: '#/painel', ico: 'layout-grid', label: 'Início', count: (c.proposals ?? 0) + (c.evaluations ?? 0), self: true },
        app.feature('perfil') && { href: '#/perfil', ico: 'user-circle', label: 'Meu Perfil', hint: 'Sua apresentação, suas áreas, reuniões e o que você já fez.' },
        app.feature('avisos') && { href: '#/avisos', ico: 'bell', label: 'Avisos', count: c.announcements ?? 0, hint: app.can('avisos.enviar') ? 'Ler os avisos da Direção, criar novos e ver quem já leu.' : 'Avisos da Direção para a equipe.' },
      ],
    },
    {
      id: 'consulta', title: 'Consulta',
      items: [
        { href: '#/', ico: 'file-text', label: 'Procedimentos', procedures: true, hint: 'Passo a passo de cada situação, por categoria.' },
        app.feature('regras') && (app.can('regras.ler') || app.can('regras.editar'))
          && { href: '#/regras', ico: 'book', label: 'Livro de Regras', hint: 'As regras do servidor, por categoria.' },
        lore && app.feature('lore') && { href: '#/lore/personagens', ico: 'users-group', label: 'Personagens', hint: 'Personagens aprovados e a lore deles.' },
        lore && { href: '#/lore/nomes', ico: 'ban', label: 'Nomes proibidos', hint: 'Lista de nomes que não podem ser usados.' },
      ],
    },
    {
      id: 'trabalho', title: 'Trabalho',
      items: [
        app.feature('allowlist') && app.can('allowlist.avaliar') && { href: '#/allowlist', ico: 'file-check', label: 'Nova análise', hint: 'Analisar uma allowlist.' },
        app.feature('allowlist') && app.can('allowlist.avaliar') && { href: '#/entrevista', ico: 'microphone', label: 'Nova entrevista', hint: 'Fazer uma entrevista.' },
        app.feature('allowlist') && (app.can('allowlist.avaliar') || app.can('allowlist.historico'))
          && { href: '#/avaliacoes', ico: 'history', label: 'Histórico de allowlist', hint: 'Análises e entrevistas já feitas.' },
        app.feature('agenda') && (app.can('agenda.ler') || app.can('agenda.gerenciar'))
          && { href: '#/agenda', ico: 'calendar-event', label: 'Agenda de Reuniões', hint: 'Reuniões marcadas e as que estão ao vivo.' },
        app.feature('escalas') && (app.can('allowlist.avaliar') || app.can('escalas.gerenciar'))
          && { href: '#/entrevistas', ico: 'calendar-time', label: 'Escala de entrevistas', hint: 'Sua escala, a agenda das entrevistas e o registro de cada sessão.' },
        app.feature('escalas') && app.can('escalas.gerenciar')
          && { href: '#/entrevistas/gestao', ico: 'adjustments-alt', label: 'Gestão da escala', hint: 'Abrir a escala, analisar a disponibilidade, publicar e configurar.' },
        app.feature('areas') && { href: '#/areas', ico: 'users-group', label: 'Minhas Áreas', dot: (c.noAreas ?? 0) > 0, hint: 'As áreas da staff em que você atua.' },
      ],
    },
    {
      id: 'equipe', title: 'Equipe',
      items: [
        app.can('equipe.ver') && { href: '#/equipe', ico: 'users', label: 'Equipe da staff', hint: 'Membros, cargos, equipes e fichas.' },
        app.feature('aprovacao') && (app.can('procedimentos.editar') || app.can('procedimentos.aprovar'))
          && { href: '#/propostas', ico: 'checklist', label: app.can('procedimentos.aprovar') ? 'Aprovações' : 'Minhas propostas', count: c.proposals, hint: 'Procedimentos novos e edições enviados por Suporte e Moderação.' },
        app.feature('avaliacoes') && evaluations
          && { href: '#/avaliacoes-equipe', ico: 'star', label: 'Avaliações da equipe', count: c.evaluations, hint: 'Avaliações do Head Staff e caixa da Direção.' },
        app.feature('produtividade') && app.can('produtividade.ver') && { href: '#/controle', ico: 'chart-bar', label: 'Produtividade', hint: 'Quem mais lê allowlist e faz entrevista.' },
        app.feature('areas') && app.can('areas.gerenciar') && { href: '#/areas/gerenciar', ico: 'settings', label: 'Gerenciar Áreas', hint: 'Criar áreas, membros, tags e comunicados.' },
        app.feature('diretoria') && app.can('diretoria.ver') && { href: '#/diretoria', ico: 'crown', label: 'Painel da Diretoria', hint: 'A equipe toda: avaliações, produtividade, ocorrências e cargos.' },
        // Plano 11: sem diretoria.ver, o painel abre só nas abas permitidas (Avaliações e/ou Alinhamentos).
        app.feature('diretoria') && !app.can('diretoria.ver') && app.feature('avaliacoes_area') && app.can('diretoria.avaliacoes')
          && { href: '#/diretoria/avaliacoes', ico: 'crown', label: 'Painel da Diretoria', hint: 'Médias das avaliações por área e as avaliações do Head Staff.' },
        app.feature('diretoria') && !app.can('diretoria.ver') && !(app.feature('avaliacoes_area') && app.can('diretoria.avaliacoes'))
          && app.feature('alinhamento') && app.can('alinhamento.chamar')
          && { href: '#/diretoria/alinhamentos', ico: 'crown', label: 'Painel da Diretoria', hint: 'Chamar membros para alinhamento.' },
      ],
    },
    {
      id: 'config', title: 'Configuração',
      items: [
        app.can('permissoes.editar') && { href: '#/permissoes', ico: 'shield-lock', label: 'Permissões dos cargos', hint: 'O que cada cargo pode fazer.' },
        app.feature('allowlist') && app.can('lore.gerenciar') && { href: '#/gabarito', ico: 'list-check', label: 'Gabarito e checklist', hint: 'Respostas esperadas e checklist da allowlist.' },
        app.feature('allowlist') && app.can('webhooks.gerenciar') && { href: '#/configuracoes/webhooks', ico: 'webhook', label: 'Webhooks do Discord', hint: 'Canais que recebem os resultados de allowlist e entrevistas.' },
        app.feature('auditoria') && app.can('auditoria.ver') && { href: '#/auditoria', ico: 'history', label: 'Auditoria', hint: 'Registro das ações sensíveis.' },
        app.can('procedimentos.backup') && { href: '#/admin', ico: 'database-export', label: 'Exportar e importar', hint: 'Backup completo dos procedimentos.' },
      ],
    },
  ];
  return groups
    .map((g) => ({ ...g, items: g.items.filter(Boolean) }))
    .filter((g) => g.items.length > 0);
}

export function renderSidebar(app) {
  const { procedures, filters } = app.state;
  const visible = procedures.filter((p) => p.status !== 'arquivado');
  const counts = new Map();
  for (const p of visible) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const categories = CATEGORIES.filter((c) => counts.has(c));
  const archivedCount = procedures.length - visible.length;

  const item = (value, label, count) => h('li', {},
    h('button', {
      type: 'button', class: 'cat-item',
      'aria-current': String(filters.category === value),
      onclick: () => app.setFilters({ category: value }),
    },
    h('span', { class: 'cat-label' }, label),
    h('span', { class: 'cat-count' }, h('span', { class: 'sr-only' }, ', '), count, h('span', { class: 'sr-only' }, ' procedimentos'))));

  const navLink = ({ href, ico, label, count, dot }) =>
    h('a', { class: 'cat-item', href, 'data-nav': '', 'aria-current': String(app.router.route.hash === href) },
      h('span', { class: 'cat-label' }, icon(ico), ' ', label),
      dot && h('span', { class: 'areas-dot', 'data-testid': 'areas-dot' }, h('span', { class: 'sr-only' }, 'Escolha uma área')),
      count > 0 && h('span', { class: 'cat-count cat-count--alert' }, h('span', { class: 'sr-only' }, ', '), count, h('span', { class: 'sr-only' }, ' novos')));

  // Procedimentos: categorias dentro de um bloco recolhível (aberto nas telas de procedimento).
  // No celular o CSS mostra a lista sempre (são os "chips" de categoria).
  const onProcedures = ['home', 'procedure', 'new', 'edit', 'history'].includes(app.router.route.name);
  const toggleProcs = (e) => {
    const open = e.currentTarget.closest('.sidebar-procs').classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  };
  const proceduresBlock = h('div', { class: `sidebar-procs${onProcedures ? ' is-open' : ''}` },
    h('button', { type: 'button', class: 'cat-item sidebar-procs-toggle', 'aria-expanded': String(onProcedures), onclick: toggleProcs },
      h('span', { class: 'cat-label' }, icon('file-text'), ' Procedimentos'),
      h('span', { class: 'cat-count' }, visible.length)),
    h('div', { class: 'sidebar-procs-body' },
      h('nav', { 'aria-label': 'Categorias de procedimentos' },
        h('ul', { class: 'cat-list' },
          item('', 'Todas', visible.length),
          categories.map((c) => item(c, c, counts.get(c))))),
      app.can('procedimentos.arquivar') && archivedCount > 0 && h('div', { class: 'sidebar-tools' },
        h('button', {
          type: 'button', class: 'cat-item',
          'aria-current': String(filters.status === 'arquivado'),
          onclick: () => app.setFilters({ status: filters.status === 'arquivado' ? '' : 'arquivado' }),
        }, h('span', { class: 'cat-label' }, 'Arquivados'), h('span', { class: 'cat-count' }, archivedCount)))));

  app.els.sidebar.replaceChildren(...[
    app.can('procedimentos.editar') && h('a', { class: 'btn btn--primary btn--block sidebar-new', href: '#/novo' }, icon('plus'), 'Novo procedimento'),
    ...navGroups(app).map((g) => h('nav', { class: 'sidebar-group', id: `sidebar-${g.id}`, 'aria-labelledby': `sidebar-${g.id}-title` },
      h('h2', { class: 'sidebar-title', id: `sidebar-${g.id}-title` }, g.title),
      g.items.some((i) => i.procedures) && proceduresBlock,
      h('div', { class: 'sidebar-tools' }, g.items.filter((i) => !i.procedures).map(navLink)))),
  ].filter(Boolean));
}
