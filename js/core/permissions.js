// Cargos, permissões e travas da hierarquia (documento 01-controle-da-staff, seções 1 e 2).
// Fonte única no JavaScript: o mock simula o banco com estas regras, o supabase-adapter usa
// para respostas rápidas e a interface para mostrar ou esconder botões. Quem garante de
// verdade é o banco (supabase/01, 02, 03 e 05); tests/db/banco.test.mjs confere que o
// catálogo e as mensagens daqui são iguais aos do SQL.

/** Os 8 cargos, do menor para o maior nível. Os códigos antigos ficam: `admin` aparece como "Resp. Equipe" e `manager` como "Administrador" (plano 10). */
export const ROLE_LIST = Object.freeze([
  Object.freeze({ code: 'allowlist', label: 'Allowlist', level: 1 }),
  Object.freeze({ code: 'lore', label: 'Lore', level: 2 }),
  Object.freeze({ code: 'suporte', label: 'Suporte', level: 3 }),
  Object.freeze({ code: 'moderador', label: 'Moderador', level: 4 }),
  Object.freeze({ code: 'head_staff', label: 'Head Staff', level: 5 }),
  Object.freeze({ code: 'admin', label: 'Resp. Equipe', level: 6 }),
  Object.freeze({ code: 'manager', label: 'Administrador', level: 7 }),
  Object.freeze({ code: 'ceo', label: 'CEO', level: 8 }),
]);

export const ROLE_CODES = Object.freeze(ROLE_LIST.map((r) => r.code));
export const ROLE_LABELS = Object.freeze(Object.fromEntries(ROLE_LIST.map((r) => [r.code, r.label])));
export const CEO = 'ceo';

/** Nível a partir do qual o cargo é da Direção (Resp. Equipe, Administrador e CEO). */
export const DIRECTION_LEVEL = 6;

/** TAGs de equipe (opcionais): somam as permissões do cargo de mesmo nome, sem mudar o nível. */
export const TEAMS = Object.freeze(['allowlist', 'lore']);
export const TEAM_LABELS = Object.freeze({ allowlist: 'Equipe de Allowlist', lore: 'Equipe de Lore' });

const ALL_BELOW_CEO = ['allowlist', 'lore', 'suporte', 'moderador', 'head_staff', 'admin', 'manager'];
const FROM_SUPPORT = ['suporte', 'moderador', 'head_staff', 'admin', 'manager'];
const FROM_HEAD = ['head_staff', 'admin', 'manager'];
const DIRECTION = ['admin', 'manager'];

/**
 * Catálogo de permissões e o padrão inicial de cada cargo (o CEO tem todas, sempre).
 * `ceoOnly`: só o CEO liga ou desliga esta permissão para os outros cargos (Decisão 4).
 */
export const PERMISSIONS = Object.freeze([
  { code: 'procedimentos.ler', description: 'Ver e buscar todos os procedimentos', roles: FROM_SUPPORT },
  { code: 'procedimentos.ler_allowlist', description: 'Ver e buscar os procedimentos de público Allowlist', roles: ALL_BELOW_CEO },
  { code: 'procedimentos.favoritar', description: 'Favoritar e marcar procedimentos como revisados', roles: ALL_BELOW_CEO },
  { code: 'procedimentos.editar', description: 'Criar e editar procedimentos e passos', roles: FROM_SUPPORT },
  { code: 'procedimentos.aprovar', description: 'Publicar procedimentos direto e aprovar as propostas dos outros cargos', roles: FROM_HEAD },
  { code: 'procedimentos.arquivar', description: 'Arquivar, restaurar e voltar versão de procedimentos', roles: ['moderador', ...FROM_HEAD] },
  { code: 'procedimentos.backup', description: 'Exportar e importar procedimentos', roles: DIRECTION },
  { code: 'allowlist.avaliar', description: 'Analisar allowlist e fazer entrevista', roles: ALL_BELOW_CEO },
  { code: 'allowlist.historico', description: 'Ver o histórico de análises e entrevistas de todos', roles: FROM_HEAD },
  { code: 'lore.consultar', description: 'Consultar personagens em uso e nomes proibidos', roles: ALL_BELOW_CEO },
  { code: 'lore.gerenciar', description: 'Cadastrar nomes proibidos e personagens', roles: ['lore', ...FROM_HEAD] },
  { code: 'lore.anotacoes', description: 'Ler e escrever anotações de admin dos personagens', roles: DIRECTION },
  { code: 'equipe.ver', description: 'Ver a lista da equipe', roles: FROM_HEAD },
  { code: 'equipe.gerenciar', description: 'Adicionar, editar, desativar e remover membros', roles: DIRECTION },
  { code: 'avaliacoes.criar', description: 'Avaliar membros de cargo abaixo', roles: FROM_HEAD },
  { code: 'avaliacoes.ler', description: 'Ler as avaliações e feedbacks', roles: DIRECTION },
  { code: 'avaliacoes.gerenciar', description: 'Abrir períodos de avaliação, escolher os critérios e arquivar avaliações', roles: DIRECTION },
  { code: 'produtividade.ver', description: 'Ver o painel de produtividade (números e gráficos)', roles: FROM_HEAD },
  { code: 'avisos.enviar', description: 'Criar e enviar avisos', roles: DIRECTION },
  { code: 'auditoria.ver', description: 'Ver o registro de ações sensíveis', roles: DIRECTION },
  { code: 'permissoes.editar', description: 'Ligar e desligar permissões dos cargos', roles: [], ceoOnly: true },
  { code: 'configuracoes.editar', description: 'Configurações gerais do site', roles: DIRECTION },
  { code: 'webhooks.gerenciar', description: 'Cadastrar, editar e remover webhooks do Discord', roles: DIRECTION },
  { code: 'regras.ler', description: 'Ler o Livro de Regras', roles: ALL_BELOW_CEO },
  { code: 'regras.editar', description: 'Criar, editar e apagar regras do Livro de Regras', roles: DIRECTION },
  { code: 'agenda.ler', description: 'Ver a Agenda de Reuniões', roles: ALL_BELOW_CEO },
  { code: 'agenda.gerenciar', description: 'Criar, editar e apagar reuniões da Agenda', roles: FROM_HEAD },
  { code: 'areas.gerenciar', description: 'Gerenciar as Áreas da Staff: áreas, membros, tags e mensagens', roles: DIRECTION },
  { code: 'diretoria.ver', description: 'Abrir o Painel da Diretoria: avaliar, registrar ocorrências e ver o histórico de cargos', roles: DIRECTION },
  { code: 'diretoria.gerenciar', description: 'Editar as regras de promoção e exportar a produtividade do Painel da Diretoria', roles: ['manager'] },
  { code: 'diretoria.avaliacoes', description: 'Abrir a aba Avaliações do Painel da Diretoria: médias por área e avaliações do Head Staff', roles: FROM_HEAD },
  { code: 'alinhamento.chamar', description: 'Chamar membros para alinhamento pelo bot (privado, canal e Agenda)', roles: DIRECTION },
  { code: 'escalas.gerenciar', description: 'Gerenciar a escala das entrevistas: abrir, analisar, publicar, realocar, configurar e editar registros', roles: DIRECTION },
].map((p) => Object.freeze({ ceoOnly: false, ...p, roles: Object.freeze([...p.roles]) })));

export const PERMISSION_CODES = Object.freeze(PERMISSIONS.map((p) => p.code));

export const roleLevel = (role) => ROLE_LIST.find((r) => r.code === role)?.level ?? 0;
export const roleLabel = (role) => ROLE_LABELS[role] ?? role ?? '';
export const isDirection = (role) => roleLevel(role) >= DIRECTION_LEVEL;

/** Grade padrão: { [cargo]: { [permissão]: boolean } } para os 7 cargos abaixo do CEO. */
export function defaultGrid() {
  const grid = {};
  for (const role of ROLE_CODES.filter((r) => r !== CEO)) {
    grid[role] = Object.fromEntries(PERMISSIONS.map((p) => [p.code, p.roles.includes(role)]));
  }
  return grid;
}

/**
 * Permissões efetivas de um membro: CEO tem todas; os outros, as do cargo somadas às das TAGs.
 * @param {{ role: string, teams?: string[] }} member
 * @param {Record<string, Record<string, boolean>>} [grid]
 * @returns {string[]} códigos em ordem alfabética
 */
export function permissionsOf(member, grid = defaultGrid()) {
  if (!member?.role) return [];
  if (member.role === CEO) return [...PERMISSION_CODES].sort();
  const sources = [member.role, ...(member.teams ?? [])];
  return PERMISSION_CODES.filter((code) => sources.some((r) => grid[r]?.[code] === true)).sort();
}

/** Quem tem estas permissões pode ver um procedimento com este público? (mesma regra da RLS) */
export function canReadAudience(perms, audience) {
  const has = (code) => perms.includes(code);
  return has('procedimentos.ler') || (audience === 'allowlist' && has('procedimentos.ler_allowlist'));
}

/* ---------------------------------------------------------------------------
 * Travas da hierarquia (seção 2.1). Mensagens IGUAIS às do trigger em
 * supabase/05_staff_admin.sql (o teste do banco confere).
 * ------------------------------------------------------------------------- */
export const STAFF_ERRORS = Object.freeze({
  selfDelete: 'Você não pode remover a própria conta. Peça a outra pessoa da Direção.',
  selfRole: 'Você não pode alterar o próprio cargo. Peça a outra pessoa da Direção.',
  selfDeactivate: 'Você não pode desativar a própria conta. Peça a outra pessoa da Direção.',
  selfTeams: 'Você não pode alterar as próprias equipes. Peça a outra pessoa da Direção.',
  manageDirection: 'Só o CEO pode gerenciar Resp. Equipe, Administradores e CEOs.',
  manageAbove: 'Você só pode gerenciar membros de cargo abaixo do seu.',
  assignDirection: 'Só o CEO pode nomear Resp. Equipe, Administradores e CEOs.',
  assignAbove: 'Você só pode dar cargos abaixo do seu.',
  lastCeo: 'É preciso manter pelo menos um CEO ativo.',
  discordId: 'O Discord ID não pode ser alterado. Remova e cadastre de novo.',
});

/** Mensagens das travas da tela de permissões (supabase/02_functions_triggers.sql). */
export const PERMISSION_ERRORS = Object.freeze({
  ceoOnly: 'Só o CEO altera quem pode mexer nas permissões.',
  ceoRow: 'O CEO tem todas as permissões, sempre. A coluna do CEO não muda.',
  unknown: 'Cargo ou permissão inexistente.',
});

/** Máximo de alterações salvas de uma vez na tela de permissões (7 cargos x catálogo, com folga). */
export const MAX_PERMISSION_CHANGES = 500;

/**
 * Confere uma lista de alterações da grade contra as travas (Decisão 4). Devolve a mensagem
 * de erro ou null. `actorRole` = cargo de quem está salvando.
 * @param {string} actorRole
 * @param {Array<{ role: string, permission: string, allowed: boolean }>} changes
 */
export function permissionChangesError(actorRole, changes) {
  if (!Array.isArray(changes) || changes.length > MAX_PERMISSION_CHANGES) return PERMISSION_ERRORS.unknown;
  for (const c of changes) {
    if (!c || typeof c !== 'object' || typeof c.allowed !== 'boolean') return PERMISSION_ERRORS.unknown;
    if (c.role === CEO) return PERMISSION_ERRORS.ceoRow;
    const perm = PERMISSIONS.find((p) => p.code === c.permission);
    if (!perm || !ROLE_CODES.includes(c.role)) return PERMISSION_ERRORS.unknown;
    if (perm.ceoOnly && actorRole !== CEO) return PERMISSION_ERRORS.ceoOnly;
  }
  return null;
}

/**
 * Diferença entre duas grades: o que precisa ser gravado para `before` virar `after`.
 * @returns {Array<{ role: string, permission: string, allowed: boolean }>}
 */
export function gridChanges(before, after) {
  const out = [];
  for (const role of ROLE_CODES.filter((r) => r !== CEO)) {
    for (const { code } of PERMISSIONS) {
      const next = after?.[role]?.[code];
      if (typeof next === 'boolean' && next !== Boolean(before?.[role]?.[code])) out.push({ role, permission: code, allowed: next });
    }
  }
  return out;
}

/** Frase simples para a janela de confirmação: "Suporte passa a poder: Criar e editar ...". */
export function describePermissionChange({ role, permission, allowed }) {
  const description = PERMISSIONS.find((p) => p.code === permission)?.description ?? permission;
  return `${roleLabel(role)} ${allowed ? 'passa a poder' : 'deixa de poder'}: ${description}`;
}

/**
 * Maior nível que alguém pode gerenciar ou atribuir: o CEO pode tudo; os outros só abaixo
 * do próprio nível e nunca a Direção (Decisão 3: só o CEO mexe em Resp. Equipe e Administrador).
 */
export function manageLimit(actorRole) {
  if (actorRole === CEO) return Infinity;
  return Math.min(roleLevel(actorRole), DIRECTION_LEVEL) - 1;
}

/** Cargos que `actorRole` pode atribuir (para o seletor da tela Equipe). */
export const assignableRoles = (actorRole) => ROLE_CODES.filter((r) => roleLevel(r) <= manageLimit(actorRole));

/** `actorRole` pode editar ou remover um membro com `targetRole`? */
export const canManageRole = (actorRole, targetRole) => roleLevel(targetRole) <= manageLimit(actorRole);

function manageError(actorRole, targetRole, kind) {
  if (roleLevel(targetRole) <= manageLimit(actorRole)) return null;
  const direction = roleLevel(targetRole) >= DIRECTION_LEVEL;
  if (kind === 'assign') return direction ? STAFF_ERRORS.assignDirection : STAFF_ERRORS.assignAbove;
  return direction ? STAFF_ERRORS.manageDirection : STAFF_ERRORS.manageAbove;
}

const sameTeams = (a = [], b = []) => [...a].sort().join(',') === [...b].sort().join(',');

/**
 * Confere uma mudança na equipe contra as travas. Devolve a mensagem de erro ou null.
 * @param {{ discord_id: string, role: string }} actor   quem está fazendo
 * @param {{ discord_id: string, role: string, active: boolean, teams?: string[] }|null} before  null = cadastro novo
 * @param {{ role: string, active: boolean, teams?: string[] }|'delete'} after
 * @param {number} otherActiveCeos   quantos CEOs ativos existem além de `before`
 */
export function staffChangeError(actor, before, after, otherActiveCeos = 1) {
  const self = before && before.discord_id === actor.discord_id;
  if (after === 'delete') {
    if (self) return STAFF_ERRORS.selfDelete;
    const e = manageError(actor.role, before.role, 'manage');
    if (e) return e;
    if (before.role === CEO && before.active && otherActiveCeos < 1) return STAFF_ERRORS.lastCeo;
    return null;
  }
  if (self) {
    if (after.role !== before.role) return STAFF_ERRORS.selfRole;
    if (after.active !== before.active) return STAFF_ERRORS.selfDeactivate;
    if (!sameTeams(after.teams, before.teams)) return STAFF_ERRORS.selfTeams;
    return null;
  }
  if (before) {
    const e = manageError(actor.role, before.role, 'manage');
    if (e) return e;
  }
  if (!before || after.role !== before.role) {
    const e = manageError(actor.role, after.role, 'assign');
    if (e) return e;
  }
  if (before?.role === CEO && before.active && (after.role !== CEO || !after.active) && otherActiveCeos < 1) {
    return STAFF_ERRORS.lastCeo;
  }
  return null;
}
