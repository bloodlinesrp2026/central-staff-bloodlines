// Roteamento por hash (#/...), com "guarda" para impedir sair de um formulário com
// alterações não salvas sem confirmação.

const ROUTES = [
  ['home', /^#?\/?$/],
  ['procedure', /^#\/p\/([a-z0-9-]+)$/],
  ['new', /^#\/novo$/],
  ['edit', /^#\/editar\/([a-z0-9-]+)$/],
  ['history', /^#\/historico\/([a-z0-9-]+)$/],
  ['admin', /^#\/admin$/],
  ['staff', /^#\/equipe$/],
  ['member', /^#\/equipe\/([0-9]{17,20})$/],
  ['permissions', /^#\/permissoes$/],
  ['proposals', /^#\/propostas$/],
  ['proposal', /^#\/propostas\/([0-9a-f-]{36})$/],
  ['evaluations', /^#\/avaliacoes-equipe$/],
  ['evaluation', /^#\/avaliacoes-equipe\/([0-9a-f-]{36}|nova)$/],
  ['announcements', /^#\/avisos(?:#aviso-[0-9a-f-]{36})?$/],
  ['audit', /^#\/auditoria$/],
  ['panel', /^#\/painel$/],
  // Etapas 6 e 7 · Allowlist e Entrevistas
  ['alForm', /^#\/allowlist(?:\/([0-9a-f-]{36}))?$/],
  ['interview', /^#\/entrevista(?:\/([0-9a-f-]{36}))?$/],
  ['alHistory', /^#\/avaliacoes$/],
  ['alDetail', /^#\/avaliacoes\/([0-9a-f-]{36})$/],
  ['webhooks', /^#\/configuracoes\/webhooks$/],
  // Etapas 8 a 10 · gabarito, Lore e produtividade
  ['gabarito', /^#\/gabarito$/],
  ['loreNames', /^#\/lore\/nomes$/],
  ['characters', /^#\/lore\/personagens$/],
  ['character', /^#\/lore\/personagens\/([0-9a-f-]{36}|novo)$/],
  ['productivity', /^#\/controle$/],
  // Livro de Regras
  ['rules', /^#\/regras(?:\/([0-9a-f-]{36}))?$/],
  // Agenda de Reuniões
  ['agenda', /^#\/agenda$/],
  // Áreas da Staff
  ['areas', /^#\/areas$/],
  ['areasAdmin', /^#\/areas\/gerenciar$/],
  ['area', /^#\/areas\/([a-z0-9-]+)$/],
  // Perfil da staff
  ['perfil', /^#\/perfil(?:\/([0-9]{17,20}))?$/],
  // Painel da Diretoria
  ['diretoria', /^#\/diretoria(?:\/(equipe|avaliacoes|produtividade|ocorrencias|cargos|alinhamentos))?$/],
];

/** @returns {{ name: string, slug?: string, hash: string }} */
export function parseRoute(hash) {
  const value = hash || '#/';
  for (const [name, re] of ROUTES) {
    const m = value.match(re);
    if (m) return { name, slug: m[1], hash: value };
  }
  return { name: 'notfound', hash: value };
}

/**
 * @param {(route: ReturnType<typeof parseRoute>) => void} onRoute
 */
export function createRouter(onRoute) {
  let current = location.hash || '#/';
  let guard = null;

  async function handle() {
    const next = location.hash || '#/';
    if (next === current) return;
    if (guard) {
      const allowed = await guard();
      if (!allowed) {
        // Desfaz a navegação sem disparar outro hashchange.
        history.replaceState(null, '', current);
        return;
      }
      guard = null;
    }
    current = next;
    onRoute(parseRoute(current));
  }

  window.addEventListener('hashchange', handle);

  return {
    /** Rota atual. */
    get route() { return parseRoute(current); },
    start() { onRoute(parseRoute(current)); },
    go(hash) {
      if ((location.hash || '#/') === hash) {
        if (current !== hash) { current = hash; onRoute(parseRoute(hash)); }
        return;
      }
      location.hash = hash;
    },
    /** Função assíncrona que devolve true para permitir sair da rota atual. */
    setGuard(fn) { guard = fn; },
    clearGuard() { guard = null; },
  };
}
