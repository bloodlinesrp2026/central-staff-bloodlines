// Implementação em memória do contrato (js/data/adapter.js), com persistência opcional
// em localStorage. SIMULA as regras do banco: cargos e permissões (js/core/permissions.js),
// público visível por cargo, travas da equipe, conflito de versão (2.7), revisões
// automáticas (2.8), arquivamento em vez de exclusão e auditoria pelo "servidor".
// Uso: desenvolvimento local (DATA_MODE = 'mock') e testes.
import {
  EDITABLE_FIELDS, EXPORT_FORMAT, FEATURES, PROCEDURE_DEFAULTS, byStaffName, fail, ok, pickEditable, pickStaffMember,
  AL_DEFAULTS, WEBHOOK_COLUMNS, pickAlAnswers, pickAlEvaluation, pickAlParticipants, pickWebhook,
} from './adapter.js';
import {
  ALIGNMENT_ERRORS, ALLOWLIST_ERRORS, AREA_DISCORD_ERRORS, AREA_HISTORY_ACTIONS, alignmentDeadlineAt, validateAlignment, AREA_MAX_MENTIONS, DISCORD_SEND_ERRORS, MAX_PRINTS, announcementRecipients, areaRecipients,
  meetingList, meetingRecipients, validateDiscordRoleIds, normalizeName, printError, sentStatus, validateAlEvaluation, validateAlExtras, validateAreaMessage,
  validateWebhook, EVALUATION_REMINDER_ERRORS, EVALUATION_REMINDER_KINDS, evaluationReminderRecipients,
} from '../core/allowlist.js';
import { APAGAR_ERRORS, validateReason } from '../core/apagar.js';
import {
  EVALUATION_DECISION_ERRORS, criteriaNotesError, decisionTargetError, justificationError, pickCriterion, resolvedAction, validateDecision,
} from '../core/avaliacoes.js';
import { STATUSES, validateProcedure, validateStaffMember } from '../core/validate.js';
import {
  BLOCKED_NAME_FIELDS, CHECKLIST_FIELDS, LORE_ERRORS, QUESTION_FIELDS, photoError, pickCharacter, pickFields,
  validateBlockedName, validateCharacter, validateCharacterNote, validateChecklistItem, validateQuestion,
} from '../core/lore.js';
import { PRODUCTIVITY_ERRORS, aggregateProductivity } from '../core/productivity.js';
import { RULE_ERRORS, pickRule, sortRules, validateRule } from '../core/rules.js';
import {
  AREA_ERRORS, AREA_MANAGE_ERRORS, AREA_ROLES, areaEventName, DEFAULT_AREA_COLOR, DEFAULT_TAG_COLOR, areaProcedureAccess, areaSlug, historyRange, pickArea,
  pickAreaProcedure, pickAreaTag, validateArea, validateAreaProcedure, validateAreaTag,
} from '../core/areas.js';
import {
  ESCALA_ERRORS, ESC_DISCORD_ERRORS, cellKey, datesInPeriod, horarioSortKey, pickEscalaConfig, sessionStart, sessionView, validateAvailability, validateEscalaConfig,
  validateOpenEscala, validatePrintFile, validateRegistro, validateRegistroEdit, validateSlots, validateSubstitution, weekdayOf, DEFAULT_ESCALA_CONFIG,
} from '../core/escalas.js';
import { PROFILE_ERRORS, pickProfileEdit, safeAvatar, validateProfileEdit } from '../core/perfil.js';
import {
  AREA_EVAL_ERRORS, DIRETORIA_ERRORS, alignmentMeetingInput, averagesByArea, pickDirectorEvaluation, promotionRulesError, reasonError,
  receivedEvaluationView, validateDirectorEvaluation, validateOccurrence, weekOf,
} from '../core/diretoria.js';
import { MEETING_STATUS_ERRORS, audienceOf, findMeetingConflict, meetingConflictMessage, participantLabel, pickMeeting, sortMeetings, validateMeeting } from '../core/agenda.js';
import {
  PROPOSAL_ERRORS, contentChanged, proposalStatus, EVALUATION_ERRORS, evaluationChangeError, validateEvaluation,
  isPeriodOpen, validateAnnouncement, isAnnouncementFor, PROPOSAL_NOTE_MAX, NO_EMOJI_MESSAGE, hasEmoji,
} from '../core/workflow.js';
import {
  CEO, PERMISSIONS, ROLE_CODES, canReadAudience, defaultGrid, permissionChangesError, permissionsOf, roleLevel, staffChangeError,
} from '../core/permissions.js';

/**
 * Usuários simulados: um por cargo (a chave é o código do cargo), mais um staff inativo e um
 * logado não cadastrado (`role: null`).
 */
export const MOCK_USERS = Object.freeze({
  allowlist: { id: 'mock-u-allowlist', discord_id: '100000000000000005', name: 'Allowlist Teste', role: 'allowlist', active: true },
  lore: { id: 'mock-u-lore', discord_id: '100000000000000006', name: 'Lore Teste', role: 'lore', active: true },
  suporte: { id: 'mock-u-suporte', discord_id: '100000000000000001', name: 'Suporte Teste', role: 'suporte', active: true },
  moderador: { id: 'mock-u-moderador', discord_id: '100000000000000002', name: 'Moderador Teste', role: 'moderador', active: true },
  head_staff: { id: 'mock-u-head', discord_id: '100000000000000007', name: 'Head Staff Teste', role: 'head_staff', active: true },
  admin: { id: 'mock-u-admin', discord_id: '100000000000000003', name: 'Admin Teste', role: 'admin', active: true },
  manager: { id: 'mock-u-manager', discord_id: '100000000000000008', name: 'Manager Teste', role: 'manager', active: true },
  ceo: { id: 'mock-u-ceo', discord_id: '100000000000000010', name: 'CEO Teste', role: 'ceo', active: true },
  inativo: { id: 'mock-u-inativo', discord_id: '100000000000000004', name: 'Ex-staff Teste', role: 'moderador', active: false },
  naostaff: { id: 'mock-u-naostaff', discord_id: '100000000000000009', name: 'Visitante Teste', role: null, active: false },
});

const STATE_VERSION = 3;
/** Os 6 critérios iniciais das avaliações (documento 01, seção 6.2; os mesmos do 08). */
const INITIAL_CRITERIA = Object.freeze([
  'Postura e respeito no atendimento', 'Conhecimento das regras e da lore', 'Comunicação com players e equipe',
  'Atividade e assiduidade', 'Trabalho em equipe', 'Qualidade dos registros (entrevistas, allowlists, tickets)',
]);
const clone = (v) => structuredClone(v);
const byTitle = (a, b) => a.title.localeCompare(b.title, 'pt-BR');
const uuid = () => globalThis.crypto.randomUUID();

function initialState(seed, adminId, nowIso) {
  const staff = Object.values(MOCK_USERS)
    .filter((u) => u.role)
    .map((u) => ({ discord_id: u.discord_id, display_name: u.name, role: u.role, teams: [], active: u.active, created_at: nowIso }));
  const procedures = seed.map((item) => ({
    id: uuid(),
    ...PROCEDURE_DEFAULTS,
    ...pickEditable(item),
    last_reviewed_at: item.last_reviewed_at ?? null,
    last_reviewed_by: item.last_reviewed_at ? adminId : null,
    version: 1,
    created_by: adminId, created_at: nowIso,
    updated_by: adminId, updated_at: nowIso,
  }));
  const criteria = INITIAL_CRITERIA.map((label, i) => ({ id: uuid(), label, sort_order: i + 1, active: true, created_at: nowIso }));
  return {
    v: STATE_VERSION, staff, procedures, revisions: [], favorites: [], grid: defaultGrid(),
    proposals: [], periods: [], criteria, evaluations: [], announcements: [], reads: [], audit: [],
  };
}

/** Etapa 5: dados do módulo de Allowlist (data/allowlist-seed.json), como o 11_allowlist_seed.sql. */
function allowlistState(seed, nowIso) {
  const meta = { active: true, created_by: 'sistema', created_at: nowIso, updated_by: 'sistema', updated_at: nowIso };
  return {
    questions: (seed?.questions ?? []).map((q) => ({ id: uuid(), ...q, extra_note: q.extra_note ?? '', ...meta })),
    checklistItems: (seed?.checklist ?? []).map((c) => ({ id: uuid(), ...c, hint: c.hint ?? '', ...meta })),
    blockedNames: (seed?.blocked_names ?? []).map((n) => ({
      id: uuid(), name: n.name, name_norm: normalizeName(n.name), kind: n.kind, reason: 'serie', series: n.series,
      character_id: null, reason_text: '', mode: n.mode ?? 'bloqueia', ...meta,
    })),
    alEvaluations: [], alParticipants: [], alAnswers: [], alAttachments: [], webhooks: [],
    ...loreState(),
    ...rulesState(),
    ...agendaState(),
    ...escalasState(),
    ...areasState(nowIso),
    ...diretoriaState(),
  };
}

/** Painel da Diretoria: vazio no começo (como o 21_diretoria.sql). */
const diretoriaState = () => ({
  dirEvaluations: [], occurrences: [], roleHistory: [], promotionRules: { conteudo: '', atualizado_por: null, atualizado_em: null },
  alignments: [],
});

/** Etapa 9: personagens, histórico e anotações (vazios no começo, como o 12_lore.sql). */
const loreState = () => ({ characters: [], characterRevisions: [], characterNotes: [] });

/** Livro de Regras: vazio no começo (o conteúdo inicial vem do 16_regras_seed.sql no banco). */
const rulesState = () => ({ rules: [] });

/** Agenda de Reuniões: vazia no começo. Cada reunião guarda seus convocados em `participants`. */
const agendaState = () => ({ meetings: [] });

/** Escala e registro das entrevistas (24_escalas.sql): configuração padrão e tudo vazio. */
const escalasState = () => ({
  escCfg: { ...structuredClone(DEFAULT_ESCALA_CONFIG), atualizado_por: null, atualizado_em: null },
  escalas: [], escDisp: [], escResp: [], escSlots: [], escSessoes: [], escPart: [], escRegs: [], escHist: [],
});

/** Áreas da Staff: algumas áreas de exemplo (o banco começa vazio; a gestão cria as reais), sem membros. */
const areasState = (nowIso) => {
  const area = (nome, slug, descricao, icone, cor, nivel_minimo, ordem) => ({
    id: uuid(), nome, slug, descricao, icone, cor, nivel_minimo, status: 'ativa', discord_role_id: null, discord_canal_id: null,
    ordem, criado_por: 'sistema', criado_em: nowIso, atualizado_em: nowIso,
  });
  return {
    areas: [
      area('Tickets - Clãs', 'tickets-clas', 'Pedidos e dúvidas sobre clãs.', 'users-group', '#8b0000', 3, 1),
      area('Tickets - Bug', 'tickets-bug', 'Relatos de bugs e erros técnicos.', 'bug', '#3a6ea5', 3, 2),
      area('Tickets - Avançado', 'tickets-avancado', 'Casos que exigem Head Staff ou acima.', 'shield-lock', '#6b4a8c', 5, 3),
    ],
    areaMembers: [], areaTags: [], areaProcedures: [], areaHistory: [], areaComms: [],
  };
};

/**
 * @param {{
 *   seed?: object[],              procedimentos iniciais (campos editáveis + last_reviewed_at opcional)
 *   user?: keyof MOCK_USERS|null, usuário simulado inicial (padrão: nenhum = deslogado)
 *   storage?: Storage|null,       ex.: window.localStorage; null = só memória
 *   storageKey?: string,
 *   now?: () => Date,             relógio (injetável nos testes)
 *   allowlistSeed?: object,       data/allowlist-seed.json (perguntas, checklist e nomes proibidos)
 * }} [options]
 */
export function createMockAdapter({
  seed = [], user = null, storage = null, storageKey = 'bloodlines-kb:mock', now = () => new Date(), allowlistSeed = null,
} = {}) {
  const nowIso = () => now().toISOString();
  const adminId = MOCK_USERS.admin.discord_id;
  const fresh = () => ({ ...initialState(seed, adminId, nowIso()), ...allowlistState(allowlistSeed, nowIso()) });
  /** Arquivos dos prints: só em memória (o armazenamento guarda só os dados). */
  const printFiles = new Map();
  /** Fotos dos personagens (Etapa 9): só em memória. */
  const photoFiles = new Map();

  let state = load() ?? fresh();
  let sessionKey = loadSession() ?? user;
  let offline = false;
  const pendingFailures = new Map();
  const listeners = new Set();
  save();

  /* ---------- persistência ---------- */
  function load() {
    try {
      const raw = storage?.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed?.v !== STATE_VERSION) return null;
      // Estado salvo antes da Etapa 5: ganha os dados da Allowlist sem perder o resto.
      if (!parsed.questions) Object.assign(parsed, allowlistState(allowlistSeed, nowIso()));
      if (!parsed.characters) Object.assign(parsed, loreState());
      if (!parsed.rules) Object.assign(parsed, rulesState());
      if (!parsed.meetings) Object.assign(parsed, agendaState());
      if (!parsed.escCfg) Object.assign(parsed, escalasState());
      if (!parsed.areas) Object.assign(parsed, areasState(nowIso()));
      if (!parsed.dirEvaluations) Object.assign(parsed, diretoriaState());
      return parsed;
    } catch { return null; }
  }
  function loadSession() {
    try {
      const key = storage?.getItem(`${storageKey}:session`);
      return key && MOCK_USERS[key] ? key : null;
    } catch { return null; }
  }
  function save() {
    try {
      storage?.setItem(storageKey, JSON.stringify(state));
      if (sessionKey) storage?.setItem(`${storageKey}:session`, sessionKey);
      else storage?.removeItem(`${storageKey}:session`);
    } catch { /* armazenamento indisponível: segue só em memória */ }
  }

  /* ---------- identidade e permissões ---------- */
  const currentUser = () => (sessionKey ? MOCK_USERS[sessionKey] : null);
  const sessionOf = (u) => (u ? { user: { id: u.id, discord_id: u.discord_id, name: u.name, avatar_url: null } } : null);
  const staffOf = (u) => (u ? state.staff.find((s) => s.discord_id === u.discord_id && s.active) ?? null : null);
  const nameOf = (discordId) => state.staff.find((s) => s.discord_id === discordId)?.display_name ?? null;
  const permsOf = (staff) => permissionsOf(staff, state.grid);

  function notify() {
    const session = sessionOf(currentUser());
    for (const cb of listeners) { try { cb(clone(session)); } catch { /* ouvinte com erro não derruba os outros */ } }
  }

  /**
   * Executa uma operação respeitando: rede, sessão e permissão.
   * need: 'session' (só exige login) | 'staff' | código de permissão (ex.: 'procedimentos.backup')
   * Para não-staff, `nonStaff` define a resposta (ex.: lista vazia, como a RLS faria).
   * `fn` recebe { user, staff, can(código), sees(procedimento) }.
   */
  async function run(method, need, fn, { nonStaff } = {}) {
    if (offline) return fail('NETWORK');
    const forced = pendingFailures.get(method);
    if (forced) { pendingFailures.delete(method); return fail(forced); }

    // Relê o armazenamento: outra aba pode ter gravado (simula um banco compartilhado).
    state = load() ?? state;

    const u = currentUser();
    if (!u) return fail('UNAUTHORIZED');
    const staff = staffOf(u);
    if (need !== 'session' && !staff) return nonStaff ? nonStaff() : fail('FORBIDDEN');
    const perms = permsOf(staff);
    const can = (code) => perms.includes(code);
    if (need !== 'session' && need !== 'staff' && !can(need)) return fail('FORBIDDEN');
    const sees = (p) => Boolean(p) && canReadAudience(perms, p.audience);
    try {
      return await fn({ user: u, staff, can, sees });
    } catch (err) {
      return fail('NETWORK', `Erro inesperado: ${err?.message ?? err}`);
    }
  }

  /* ---------- entrevistas: escala e registro ---------- */
  const escCanRead = (can) => can('allowlist.avaliar') || can('escalas.gerenciar');
  const escEligible = (discordId) => {
    const s = state.staff.find((x) => x.discord_id === discordId && x.active);
    return Boolean(s) && permsOf(s).includes('allowlist.avaliar');
  };
  const escIsParticipant = (sessaoId, discordId) => state.escPart.some((p) => p.sessao_id === sessaoId && p.discord_id === discordId && p.presente);
  const escTimeKey = (horario) => horarioSortKey(horario);
  const ESC_CONFIG_KEYS = ['dias_semana', 'horarios', 'antecedencia_aviso_minutos', 'canal_discord_escala', 'canal_discord_registros',
    'canal_discord_avisos', 'cargo_discord_entrevistador', 'cargo_discord_suporte', 'mensagem_link_call', 'mensagem_cargo_id'];
  /** Só o que mudou (kb_audit_entrevistas_configuracao): { before, after } ou null se nada mudou. */
  function escConfigDiff(from, to) {
    const keys = ESC_CONFIG_KEYS.filter((k) => JSON.stringify(from[k] ?? null) !== JSON.stringify(to[k] ?? null));
    if (!keys.length) return null;
    return { before: Object.fromEntries(keys.map((k) => [k, clone(from[k] ?? null)])), after: Object.fromEntries(keys.map((k) => [k, clone(to[k] ?? null)])) };
  }
  const escLog = (tipo, ref, actor, antes, depois) => state.escHist.push({
    id: state.escHist.length + 1, tipo, referencia_id: ref, discord_id: actor ?? 'sistema', dados_anteriores: antes ?? null, dados_novos: depois ?? null, criado_em: nowIso(),
  });
  const escPresentSlot = (s) => ({ ...clone(s), display_name: nameOf(s.discord_id) });
  function escPresentSession(s) {
    const participantes = state.escPart.filter((p) => p.sessao_id === s.id)
      .map((p) => ({ discord_id: p.discord_id, display_name: nameOf(p.discord_id), funcao: p.funcao, substituindo_id: p.substituindo_id, presente: p.presente }));
    const out = { ...clone(s), tem_registro: state.escRegs.some((r) => r.sessao_id === s.id), participantes };
    return { ...out, view: sessionView(out, now()) };
  }

  /* ---------- procedimentos ---------- */
  function present(p) {
    const out = clone(p);
    out.created_by_name = nameOf(p.created_by);
    out.updated_by_name = nameOf(p.updated_by);
    out.last_reviewed_by_name = p.last_reviewed_by ? nameOf(p.last_reviewed_by) : null;
    return out;
  }
  const editableOf = (p) => Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, clone(p[f])]));
  const presentStaff = (s) => ({
    discord_id: s.discord_id, display_name: s.display_name, role: s.role, teams: [...(s.teams ?? [])],
    active: s.active, created_at: s.created_at ?? null,
  });
  const notFound = () => fail('NOT_FOUND', 'Procedimento não encontrado.');
  const findById = (id) => state.procedures.find((p) => p.id === id);
  const slugTaken = (slug, exceptId) => state.procedures.some((p) => p.slug === slug && p.id !== exceptId);

  function validationError(errors) {
    return fail('VALIDATION', undefined, { errors });
  }

  /** Valida conteúdo e unicidade do slug. Devolve um erro ou null. */
  function check(next, exceptId) {
    const { valid, errors } = validateProcedure(next);
    if (!valid) return validationError(errors);
    if (slugTaken(next.slug, exceptId)) {
      return validationError({ slug: 'Slug: já existe outro procedimento com este endereço.' });
    }
    return null;
  }

  /** Grava uma nova versão (o "trigger": guarda o estado anterior em revisões). */
  function commit(old, changes, staff) {
    if ('status' in changes && (old.status === 'arquivado') !== (changes.status === 'arquivado')) {
      audit(staff, 'procedimento', old.id, changes.status === 'arquivado' ? 'arquivado' : 'restaurado',
        { status: old.status }, { status: changes.status, slug: changes.slug ?? old.slug, title: changes.title ?? old.title });
    }
    state.revisions.push({
      id: uuid(),
      procedure_id: old.id,
      version: old.version,
      snapshot: clone(old),
      changed_by: old.updated_by,
      changed_at: old.updated_at,
    });
    Object.assign(old, clone(changes), {
      version: old.version + 1,
      updated_by: staff.discord_id,
      updated_at: nowIso(),
    });
    save();
    return old;
  }

  const touchesArchive = (from, to) => from === 'arquivado' || to === 'arquivado';
  const staffAudit = (m) => ({ display_name: m.display_name, role: m.role, teams: [...(m.teams ?? [])], active: m.active });

  /** Histórico de cargos (no banco, trigger em staff_members do 21_diretoria.sql). */
  function logRoleChange(membroId, from, to, motivo, actor) {
    state.roleHistory.push({
      id: state.roleHistory.length + 1, membro_id: membroId, cargo_anterior: from, cargo_novo: to,
      motivo: motivo || null, feito_por: actor?.discord_id ?? 'sistema', feito_em: nowIso(),
    });
  }

  /** Registro de auditoria (no banco, feito por trigger; aqui, pelo "servidor" simulado). */
  function audit(actor, entity, entityId, action, before, after) {
    state.audit.push({
      id: state.audit.length + 1, at: nowIso(), actor: actor?.discord_id ?? 'sistema',
      entity, entity_id: String(entityId), action, before: before ?? null, after: after ?? null,
    });
  }

  /** Documento 14 (kb_audit_apagar): before = como era; after = cargo de quem fez e o motivo. */
  function auditApagar(actor, entity, entityId, action, before, reason, extra = {}) {
    audit(actor, entity, entityId, action, before, { cargo: actor?.role ?? null, motivo: reason ?? null, ...extra });
  }
  /** Motivo opcional do apagar (kb_apagar_motivo). Devolve { reason } ou { error } já no formato do contrato. */
  function reasonOf(text) {
    const check = validateReason(text);
    return check.valid ? { reason: check.reason } : { error: validationError({ _: check.error }) };
  }

  const newestFirst = (a, b) => b.created_at.localeCompare(a.created_at);
  const seesEvaluations = (can) => can('avaliacoes.criar') || can('avaliacoes.ler') || can('avaliacoes.gerenciar');
  const presentProposal = (p) => ({ ...clone(p), created_by_name: nameOf(p.created_by), reviewed_by_name: p.reviewed_by ? nameOf(p.reviewed_by) : null });
  const presentEvaluation = (e) => {
    const { archived_by, archived_at, ...rest } = clone(e);
    return { justification: '', ...rest, evaluated_name: nameOf(e.evaluated_id), evaluator_name: nameOf(e.evaluator_id) };
  };
  function presentAnnouncement(a, staff) {
    const r = state.reads.find((x) => x.announcement_id === a.id && x.discord_id === staff.discord_id);
    return { ...clone(a), created_by_name: nameOf(a.created_by), my_read_at: r?.read_at ?? null, my_acknowledged_at: r?.acknowledged_at ?? null };
  }

  const presentGrid = () => ({
    permissions: PERMISSIONS.map((p) => ({ code: p.code, description: p.description, ceo_only: p.ceoOnly, default_roles: [...p.roles] })),
    grid: clone(state.grid),
  });
  const otherActiveCeos = (discordId) => state.staff.filter((s) => s.role === CEO && s.active && s.discord_id !== discordId).length;

  /* ---------- Etapas 8 e 9 (simulam o 12_lore.sql) ---------- */
  const seesLore = (can) => can('lore.consultar') || can('lore.gerenciar');
  function presentCharacter(c) {
    const file = c.photo_path ? photoFiles.get(c.photo_path) : null;
    const photo_url = c.photo_path
      ? (file && globalThis.URL?.createObjectURL ? URL.createObjectURL(file) : `mock://character-photos/${c.photo_path}`)
      : null;
    return { ...clone(c), photo_url, created_by_name: nameOf(c.created_by), updated_by_name: nameOf(c.updated_by) };
  }
  const presentRule = (r) => ({ ...clone(r), created_by_name: nameOf(r.created_by), updated_by_name: nameOf(r.updated_by) });
  const presentMeeting = (m) => ({
    ...clone(m),
    status: m.status ?? 'agendada',
    participants: m.participants.map((p) => ({ ...p, label: participantLabel(p, nameOf) })),
    created_by_name: nameOf(m.created_by), updated_by_name: nameOf(m.updated_by),
  });
  /* ---------- Áreas da Staff (simulam o 19_areas.sql) ---------- */
  /** Quem enxerga a área (RLS): membro ou gestor. Devolve o papel (ou null para gestor sem vínculo); null se não vê. */
  function areaView(area, staff, can) {
    const papel = state.areaMembers.find((m) => m.area_id === area.id && m.discord_id === staff.discord_id)?.papel ?? null;
    return papel !== null || can('areas.gerenciar') ? { papel } : null;
  }
  const areaCard = (area, papel) => area && ({
    ...clone(area), papel,
    membros: state.areaMembers.filter((m) => m.area_id === area.id).length,
    procedimentos: state.areaProcedures.filter((p) => p.area_id === area.id && p.status !== 'arquivado').length,
  });
  const presentAreaProcedure = (p) => ({ ...clone(p), criado_por_name: nameOf(p.criado_por), atualizado_por_name: nameOf(p.atualizado_por) });
  function logArea(staff, area, acao, entidade, entidadeId, detalhes) {
    state.areaHistory.push({
      id: Math.max(0, ...state.areaHistory.map((e) => e.id)) + 1, area_id: area?.id ?? null, area_nome: area?.nome ?? null,
      acao, entidade, entidade_id: entidadeId, ator_id: staff.discord_id, detalhes: clone(detalhes), criado_em: nowIso(),
    });
  }
  /** Muda o status da reunião só se estiver no estado esperado (mesma regra do banco: só anda para a frente). */
  function moveMeeting(id, from, to, wrongState, staff) {
    const row = state.meetings.find((x) => x.id === id);
    if (!row) return fail('NOT_FOUND', 'Reunião não encontrada.');
    if ((row.status ?? 'agendada') !== from) return validationError({ _: wrongState });
    Object.assign(row, { status: to, updated_by: staff.discord_id, updated_at: nowIso() });
    save();
    return ok(row);
  }
  const presentNote = (n) => ({ ...clone(n), created_by_name: nameOf(n.created_by) });

  /** Cria ou edita gabarito/checklist com autoria do "servidor". */
  function saveConfig(staff, list, input, fields, validate, defaults, onSaved) {
    const row = input.id ? list.find((x) => x.id === input.id) : null;
    if (input.id && !row) return fail('NOT_FOUND', 'Registro não encontrado.');
    const next = { ...defaults, ...(row ?? {}), ...pickFields(input, fields) };
    if (!Number.isInteger(next.position)) next.position = row?.position ?? Math.max(0, ...list.map((x) => x.position)) + 1;
    const { valid, errors } = validate(next);
    if (!valid) return validationError(errors);
    const before = row ? clone(row) : null;
    const at = nowIso();
    const target = row ?? { id: uuid(), created_by: staff.discord_id, created_at: at };
    Object.assign(target, Object.fromEntries(fields.map((f) => [f, next[f]])), { updated_by: staff.discord_id, updated_at: at });
    if (!row) list.push(target);
    onSaved?.(target, before);
    save();
    return ok(presentConfig(target));
  }

  /** Nome do personagem em Nomes proibidos (Em uso na cidade); Liberado desativa. */
  function syncCharacterName(c, staff) {
    const at = nowIso();
    const current = state.blockedNames.find((n) => n.character_id === c.id);
    if (c.status === 'liberado') {
      if (current) Object.assign(current, { active: false, updated_by: staff.discord_id, updated_at: at });
      return;
    }
    const data = { name: c.character_name, name_norm: normalizeName(c.character_name), kind: 'nome', reason: 'em_uso', series: '',
      reason_text: '', mode: 'bloqueia', active: true, updated_by: staff.discord_id, updated_at: at };
    if (current) Object.assign(current, data);
    else state.blockedNames.push({ id: uuid(), character_id: c.id, created_by: staff.discord_id, created_at: at, ...data });
  }

  const adapter = {
    /* ----- sessão ----- */
    async getSession() {
      return ok(clone(sessionOf(currentUser())));
    },

    /** No mock, `as` escolhe o usuário simulado (padrão: admin). */
    async signIn({ as = 'admin' } = {}) {
      if (offline) return fail('NETWORK');
      if (!MOCK_USERS[as]) return fail('VALIDATION', `Usuário simulado desconhecido: ${as}`);
      sessionKey = as;
      save();
      notify();
      return ok(clone(sessionOf(currentUser())));
    },

    async signOut() {
      sessionKey = null;
      save();
      notify();
      return ok(null);
    },

    onAuthChange(cb) {
      listeners.add(cb);
      return { data: { unsubscribe: () => listeners.delete(cb) }, error: null };
    },

    async getCurrentStaff() {
      return run('getCurrentStaff', 'session', async ({ user }) => {
        const staff = staffOf(user);
        return ok(staff ? {
          discord_id: staff.discord_id, display_name: staff.display_name, role: staff.role,
          level: roleLevel(staff.role), teams: [...(staff.teams ?? [])], permissions: permsOf(staff),
          features: [...FEATURES],
        } : null);
      });
    },

    /* ----- leitura ----- */
    async listProcedures({ includeArchived = false } = {}) {
      return run('listProcedures', 'staff', async ({ sees }) => ok(
        state.procedures
          .filter((p) => sees(p) && (includeArchived || p.status !== 'arquivado'))
          .sort(byTitle)
          .map(present),
      ), { nonStaff: () => ok([]) });
    },

    async getProcedure(slug) {
      return run('getProcedure', 'staff', async ({ sees }) => {
        const p = state.procedures.find((x) => x.slug === slug);
        return sees(p) ? ok(present(p)) : notFound();
      }, { nonStaff: notFound });
    },

    /* ----- escrita ----- */
    async createProcedure(data) {
      return run('createProcedure', 'procedimentos.editar', async ({ staff, can, sees }) => {
        if (!can('procedimentos.aprovar')) return fail('FORBIDDEN', PROPOSAL_ERRORS.direct);
        const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(data) };
        if (next.status === 'arquivado' && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
        const invalid = check(next);
        if (invalid) return invalid;
        if (!sees(next)) return fail('FORBIDDEN');
        const at = nowIso();
        const proc = {
          id: uuid(),
          ...editableOf(next),
          last_reviewed_at: null,
          last_reviewed_by: null,
          version: 1,
          created_by: staff.discord_id, created_at: at,
          updated_by: staff.discord_id, updated_at: at,
        };
        state.procedures.push(proc);
        save();
        return ok(present(proc));
      });
    },

    async updateProcedure(id, data, expectedVersion) {
      return run('updateProcedure', 'staff', async ({ staff, can, sees }) => {
        const old = findById(id);
        if (!sees(old)) return notFound();
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        const next = { ...editableOf(old), ...pickEditable(data) };
        if (touchesArchive(old.status, next.status) && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
        if (contentChanged(old, next) && !can('procedimentos.aprovar')) return fail('FORBIDDEN', PROPOSAL_ERRORS.direct);
        if (!Number.isInteger(expectedVersion)) {
          return validationError({ version: 'Versão: informe a versão que você estava editando.' });
        }
        if (expectedVersion !== old.version) {
          return fail('CONFLICT', `Este procedimento foi alterado por ${nameOf(old.updated_by) ?? 'outra pessoa'} enquanto você editava.`, {
            current: present(old),
            updated_by_name: nameOf(old.updated_by),
          });
        }
        const invalid = check(next, old.id);
        if (invalid) return invalid;
        if (!sees(next)) return fail('FORBIDDEN');
        return ok(present(commit(old, editableOf(next), staff)));
      });
    },

    async setStatus(id, status) {
      return run('setStatus', 'staff', async ({ staff, can, sees }) => {
        const old = findById(id);
        if (!sees(old)) return notFound();
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        if (!STATUSES.includes(status)) return validationError({ status: 'Status: use ativo, revisar ou arquivado.' });
        if (touchesArchive(old.status, status) && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
        return ok(present(commit(old, { status }, staff)));
      });
    },

    async markReviewed(id) {
      return run('markReviewed', 'staff', async ({ staff, can, sees }) => {
        const old = findById(id);
        if (!sees(old)) return notFound();
        if (!can('procedimentos.favoritar')) return fail('FORBIDDEN');
        if (old.status === 'arquivado' && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
        return ok(present(commit(old, { last_reviewed_at: nowIso(), last_reviewed_by: staff.discord_id }, staff)));
      });
    },

    /* ----- histórico ----- */
    async listRevisions(procedureId) {
      return run('listRevisions', 'staff', async ({ sees }) => ok(
        state.revisions
          .filter((r) => r.procedure_id === procedureId && sees(findById(procedureId)) && sees(r.snapshot))
          .sort((a, b) => b.version - a.version)
          .map((r) => ({ ...clone(r), snapshot: present(r.snapshot), changed_by_name: nameOf(r.changed_by) })),
      ), { nonStaff: () => ok([]) });
    },

    async restoreRevision(revisionId) {
      return run('restoreRevision', 'procedimentos.arquivar', async ({ staff, can, sees }) => {
        const rev = state.revisions.find((r) => r.id === revisionId);
        if (!rev || !sees(rev.snapshot)) return fail('NOT_FOUND', 'Revisão não encontrada.');
        const old = findById(rev.procedure_id);
        if (!sees(old)) return notFound();
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        const next = editableOf(rev.snapshot);
        if (contentChanged(old, next) && !can('procedimentos.aprovar')) return fail('FORBIDDEN', PROPOSAL_ERRORS.direct);
        const invalid = check(next, old.id);
        if (invalid) return invalid;
        return ok(present(commit(old, next, staff)));
      });
    },

    /* ----- favoritos ----- */
    async listFavorites() {
      return run('listFavorites', 'staff', async ({ user }) => ok(
        state.favorites.filter((f) => f.user_id === user.id).map((f) => f.procedure_id),
      ), { nonStaff: () => ok([]) });
    },

    async addFavorite(procedureId) {
      return run('addFavorite', 'staff', async ({ user, can, sees }) => {
        if (!sees(findById(procedureId))) return notFound();
        if (!can('procedimentos.favoritar')) return fail('FORBIDDEN');
        if (!state.favorites.some((f) => f.user_id === user.id && f.procedure_id === procedureId)) {
          state.favorites.push({ user_id: user.id, procedure_id: procedureId, created_at: nowIso() });
          save();
        }
        return ok(null);
      });
    },

    async removeFavorite(procedureId) {
      return run('removeFavorite', 'staff', async ({ user }) => {
        const before = state.favorites.length;
        state.favorites = state.favorites.filter((f) => !(f.user_id === user.id && f.procedure_id === procedureId));
        if (state.favorites.length !== before) save();
        return ok(null);
      });
    },

    /* ----- exportação / importação ----- */
    async exportAll() {
      return run('exportAll', 'procedimentos.backup', async () => ok({
        format: EXPORT_FORMAT,
        version: 1,
        exported_at: nowIso(),
        procedures: [...state.procedures].sort(byTitle).map(clone),
      }));
    },

    async importAll(payload, { dryRun = false } = {}) {
      return run('importAll', 'procedimentos.backup', async ({ staff, can }) => {
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        if (!payload || payload.format !== EXPORT_FORMAT || !Array.isArray(payload.procedures)) {
          return validationError({ payload: `Arquivo: formato inválido (esperado "${EXPORT_FORMAT}" com a lista de procedimentos).` });
        }

        const items = [];
        const seen = new Set();
        const plan = [];
        payload.procedures.forEach((raw, index) => {
          const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(raw) };
          const { errors } = validateProcedure(next);
          if (next.slug && seen.has(next.slug)) errors.slug = 'Slug: repetido no arquivo.';
          seen.add(next.slug);
          if (Object.keys(errors).length) { items.push({ index, slug: next.slug ?? null, errors }); return; }
          plan.push({ next: editableOf(next), existing: state.procedures.find((p) => p.slug === next.slug) });
        });
        if (items.length) return fail('VALIDATION', `${items.length} procedimento(s) inválido(s) no arquivo.`, { items });

        const summary = { created: 0, updated: 0, unchanged: 0 };
        for (const { next, existing } of plan) {
          if (!existing) summary.created++;
          else if (JSON.stringify(editableOf(existing)) === JSON.stringify(next)) summary.unchanged++;
          else summary.updated++;
        }
        if (dryRun) return ok(summary);
        if (summary.created + summary.updated > 0 && !can('procedimentos.aprovar')) return fail('FORBIDDEN', PROPOSAL_ERRORS.direct);

        for (const { next, existing } of plan) {
          if (!existing) {
            const at = nowIso();
            state.procedures.push({
              id: uuid(), ...next, last_reviewed_at: null, last_reviewed_by: null, version: 1,
              created_by: staff.discord_id, created_at: at, updated_by: staff.discord_id, updated_at: at,
            });
          } else if (JSON.stringify(editableOf(existing)) !== JSON.stringify(next)) {
            commit(existing, next, staff);
          }
        }
        save();
        return ok(summary);
      });
    },

    /* ----- equipe (staff_members) ----- */
    async listStaff() {
      return run('listStaff', 'equipe.ver', async () => ok([...state.staff].sort(byStaffName).map(presentStaff)));
    },

    async createStaffMember(data) {
      return run('createStaffMember', 'equipe.gerenciar', async ({ staff }) => {
        const next = pickStaffMember(data);
        const { valid, errors } = validateStaffMember(next);
        if (!valid) return validationError(errors);
        const blocked = staffChangeError(staff, null, next);
        if (blocked) return validationError({ _: blocked });
        if (state.staff.some((s) => s.discord_id === next.discord_id)) {
          return validationError({ discord_id: 'Discord ID: já cadastrado na staff.' });
        }
        const member = { ...next, created_at: nowIso() };
        state.staff.push(member);
        audit(staff, 'membro', member.discord_id, 'adicionado', null, staffAudit(member));
        save();
        return ok(presentStaff(member));
      });
    },

    async updateStaffMember(discordId, changes) {
      return run('updateStaffMember', 'equipe.gerenciar', async ({ staff }) => {
        const member = state.staff.find((s) => s.discord_id === discordId);
        if (!member) return fail('NOT_FOUND', 'Membro não encontrado.');
        const patch = pickStaffMember(changes, { partial: true });
        delete patch.discord_id;
        const next = { ...member, ...patch };
        const { valid, errors } = validateStaffMember(next);
        if (!valid) return validationError(errors);
        const blocked = staffChangeError(staff, member, next, otherActiveCeos(discordId));
        if (blocked) return validationError({ _: blocked });
        const before = staffAudit(member);
        Object.assign(member, patch);
        if (JSON.stringify(before) !== JSON.stringify(staffAudit(member))) audit(staff, 'membro', discordId, 'alterado', before, staffAudit(member));
        if (before.role !== member.role) logRoleChange(member.discord_id, before.role, member.role, null, staff);
        save();
        return ok(presentStaff(member));
      });
    },

    async deleteStaffMember(discordId) {
      return run('deleteStaffMember', 'equipe.gerenciar', async ({ staff }) => {
        const member = state.staff.find((s) => s.discord_id === discordId);
        if (!member) return fail('NOT_FOUND', 'Membro não encontrado.');
        const blocked = staffChangeError(staff, member, 'delete', otherActiveCeos(discordId));
        if (blocked) return validationError({ _: blocked });
        state.staff = state.staff.filter((s) => s.discord_id !== discordId);
        audit(staff, 'membro', discordId, 'removido', staffAudit(member), null);
        save();
        return ok(null);
      });
    },

    /* ----- grade de permissões (role_permissions) ----- */
    async listPermissionGrid() {
      return run('listPermissionGrid', 'staff', async () => ok(presentGrid()));
    },

    async setPermissions(changes) {
      return run('setPermissions', 'permissoes.editar', async ({ staff }) => {
        const blocked = permissionChangesError(staff.role, changes);
        if (blocked) return validationError({ _: blocked });
        for (const c of changes) {
          if (state.grid[c.role][c.permission] !== c.allowed) {
            audit(staff, 'permissao', `${c.role}:${c.permission}`, c.allowed ? 'ligada' : 'desligada', { allowed: !c.allowed }, { allowed: c.allowed });
          }
          state.grid[c.role][c.permission] = c.allowed;
        }
        save();
        return ok(presentGrid());
      });
    },

    /* ----- Etapa 2B: propostas de procedimentos ----- */
    async listProposals() {
      return run('listProposals', 'staff', async ({ staff, can }) => ok(state.proposals
        .filter((p) => p.created_by === staff.discord_id || can('procedimentos.aprovar'))
        .sort(newestFirst)
        .map(presentProposal)));
    },

    async createProposal({ procedure_id: procedureId = null, base_version: baseVersion = null, data } = {}) {
      return run('createProposal', 'procedimentos.editar', async ({ staff, sees }) => {
        let current = null;
        if (procedureId) {
          current = findById(procedureId);
          if (!sees(current)) return notFound();
          if (!Number.isInteger(baseVersion)) return validationError({ version: 'Versão: informe a versão que você estava editando.' });
        }
        const next = { ...PROCEDURE_DEFAULTS, ...(current ? editableOf(current) : {}), ...pickEditable(data) };
        next.status = proposalStatus(next);
        const invalid = check(next, current?.id);
        if (invalid) return invalid;
        if (!sees(next)) return fail('FORBIDDEN');
        const proposal = {
          id: uuid(), procedure_id: procedureId, base_version: procedureId ? baseVersion : null, data: editableOf(next),
          status: 'pendente', created_by: staff.discord_id, created_at: nowIso(),
          reviewed_by: null, reviewed_at: null, review_note: '',
        };
        state.proposals.push(proposal);
        save();
        return ok(presentProposal(proposal));
      });
    },

    async cancelProposal(id) {
      return run('cancelProposal', 'staff', async ({ staff }) => {
        const pr = state.proposals.find((p) => p.id === id && p.status === 'pendente' && p.created_by === staff.discord_id);
        if (!pr) return fail('NOT_FOUND', 'Proposta não encontrada ou já analisada.');
        pr.status = 'cancelada';
        save();
        return ok(null);
      });
    },

    async reviewProposal(id, { approve, note = '' } = {}) {
      return run('reviewProposal', 'procedimentos.aprovar', async ({ staff, can }) => {
        const pr = state.proposals.find((p) => p.id === id);
        if (!pr) return fail('NOT_FOUND', 'Proposta não encontrada.');
        if (pr.status !== 'pendente') return validationError({ _: PROPOSAL_ERRORS.reviewed });
        const text = String(note ?? '').trim();
        if (text.length > PROPOSAL_NOTE_MAX) return validationError({ _: PROPOSAL_ERRORS.noteMax });
        const done = (status, procedureId) => {
          Object.assign(pr, { status, procedure_id: procedureId, reviewed_by: staff.discord_id, reviewed_at: nowIso(), review_note: text });
          if (!pr.base_version) pr.base_version = 1;
          audit(staff, 'proposta', pr.id, status, null, { procedure_id: procedureId, author: pr.created_by, title: pr.data.title });
          save();
          return ok({ status, procedure_id: procedureId });
        };
        if (!approve) {
          if (!text) return validationError({ _: PROPOSAL_ERRORS.rejectNote });
          pr.base_version = pr.base_version ?? null;
          Object.assign(pr, { status: 'recusada', reviewed_by: staff.discord_id, reviewed_at: nowIso(), review_note: text });
          audit(staff, 'proposta', pr.id, 'recusada', null, { procedure_id: pr.procedure_id, author: pr.created_by, title: pr.data.title });
          save();
          return ok({ status: 'recusada', procedure_id: pr.procedure_id });
        }
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        const data = { ...clone(pr.data), status: proposalStatus(pr.data) };
        if (!pr.procedure_id) {
          const invalid = check(data);
          if (invalid) return invalid;
          const at = nowIso();
          const proc = {
            id: uuid(), ...editableOf(data), last_reviewed_at: null, last_reviewed_by: null, version: 1,
            created_by: staff.discord_id, created_at: at, updated_by: staff.discord_id, updated_at: at,
          };
          state.procedures.push(proc);
          return done('aprovada', proc.id);
        }
        const cur = findById(pr.procedure_id);
        if (!cur) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        if (cur.status === 'arquivado') return validationError({ _: PROPOSAL_ERRORS.archived });
        const invalid = check(data, cur.id);
        if (invalid) return invalid;
        commit(cur, editableOf(data), staff);
        return done('aprovada', cur.id);
      });
    },

    /* ----- Etapa 3: avaliações da equipe ----- */
    async listEvaluationPeriods() {
      return run('listEvaluationPeriods', 'staff', async ({ can }) => {
        if (!seesEvaluations(can)) return fail('FORBIDDEN');
        return ok([...state.periods].sort((a, b) => b.starts_at.localeCompare(a.starts_at)).map(clone));
      });
    },

    async saveEvaluationPeriod(period = {}) {
      return run('saveEvaluationPeriod', 'avaliacoes.gerenciar', async ({ staff }) => {
        const title = String(period.title ?? '').trim();
        const errors = {};
        if (!title || title.length > 80) errors.title = 'Nome do período: de 1 a 80 caracteres.';
        const startsAt = period.starts_at ?? nowIso();
        const endsAt = period.ends_at;
        if (!endsAt || !(new Date(endsAt) > new Date(startsAt))) errors.ends_at = 'Fim: precisa ser depois do início.';
        if (Object.keys(errors).length) return validationError(errors);
        let row = period.id ? state.periods.find((x) => x.id === period.id) : null;
        if (period.id && !row) return fail('NOT_FOUND', 'Período não encontrado.');
        const before = row ? { starts_at: row.starts_at, ends_at: row.ends_at } : null;
        if (!row) {
          row = { id: uuid(), created_by: staff.discord_id, created_at: nowIso() };
          state.periods.push(row);
        }
        Object.assign(row, { title, starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString() });
        audit(staff, 'periodo', row.id, before ? 'alterado' : 'aberto', before, { title, starts_at: row.starts_at, ends_at: row.ends_at });
        save();
        return ok(clone(row));
      });
    },

    async listEvaluationCriteria() {
      return run('listEvaluationCriteria', 'staff', async ({ can }) => {
        if (!seesEvaluations(can)) return fail('FORBIDDEN');
        return ok([...state.criteria].sort((a, b) => a.sort_order - b.sort_order).map(({ created_at, ...c }) => clone(c)));
      });
    },

    async saveEvaluationCriterion(c = {}) {
      return run('saveEvaluationCriterion', 'avaliacoes.gerenciar', async () => {
        const label = String(c.label ?? '').trim();
        if (!label || label.length > 80) return validationError({ label: 'Critério: de 1 a 80 caracteres.' });
        let row = c.id ? state.criteria.find((x) => x.id === c.id) : null;
        if (c.id && !row) return fail('NOT_FOUND', 'Critério não encontrado.');
        if (!row) {
          row = { id: uuid(), created_at: nowIso(), sort_order: Math.max(0, ...state.criteria.map((x) => x.sort_order)) + 1, active: true };
          state.criteria.push(row);
        }
        Object.assign(row, { label, ...(Number.isInteger(c.sort_order) ? { sort_order: c.sort_order } : {}), ...(typeof c.active === 'boolean' ? { active: c.active } : {}) });
        save();
        const { created_at, ...out } = row;
        return ok(clone(out));
      });
    },

    async listEvaluableMembers() {
      return run('listEvaluableMembers', 'avaliacoes.criar', async ({ staff }) => ok(state.staff
        .filter((s) => s.active && s.discord_id !== staff.discord_id && roleLevel(s.role) < roleLevel(staff.role))
        .sort(byStaffName)
        .map((s) => ({ discord_id: s.discord_id, display_name: s.display_name, role: s.role }))));
    },

    async listEvaluations() {
      return run('listEvaluations', 'staff', async ({ staff, can }) => ok(state.evaluations
        .filter((e) => e.evaluator_id === staff.discord_id
          || (can('avaliacoes.ler') && e.status !== 'rascunho' && e.evaluated_id !== staff.discord_id))
        .sort((a, b) => (b.submitted_at ?? b.updated_at).localeCompare(a.submitted_at ?? a.updated_at))
        .map(presentEvaluation)));
    },

    async saveEvaluation(input = {}) {
      return run('saveEvaluation', 'avaliacoes.criar', async ({ staff }) => {
        const before = input.id ? state.evaluations.find((e) => e.id === input.id && e.evaluator_id === staff.discord_id) : null;
        if (input.id && !before) return fail('NOT_FOUND', 'Avaliação não encontrada.');
        const fields = ['period_id', 'evaluated_id', 'status', 'criteria', 'overall', 'strengths', 'improvements', 'feedback', 'recommendation', 'justification'];
        const after = { ...(before ? clone(before) : { status: 'rascunho', criteria: [], overall: null, strengths: '', improvements: '', feedback: '', recommendation: null, justification: '' }) };
        for (const f of fields) if (f in input) after[f] = clone(input[f]);
        for (const f of ['strengths', 'improvements', 'feedback', 'justification']) after[f] = String(after[f] ?? '');
        after.overall = after.overall ?? null;
        after.recommendation = after.recommendation || null;
        // Plano 12: comentário e evidências por critério (só os campos conhecidos são guardados).
        if (Array.isArray(after.criteria)) after.criteria = after.criteria.map((c) => (c && typeof c === 'object' && typeof c.id === 'string' ? pickCriterion(c) : c));
        const { valid, errors } = validateEvaluation(after);
        if (!valid) return validationError(errors);
        const notes = criteriaNotesError(after.criteria);
        if (notes) return validationError({ criteria: notes });
        const why = justificationError(after);
        if (why) return validationError({ justification: why });
        const target = state.staff.find((m) => m.discord_id === after.evaluated_id) ?? null;
        const blocked = evaluationChangeError(staff, before, after, {
          period: state.periods.find((x) => x.id === after.period_id) ?? null, target, others: state.evaluations, now: now().getTime(),
        });
        if (blocked) return validationError({ _: blocked });
        const at = nowIso();
        let row = before;
        if (!row) {
          row = { id: uuid(), evaluator_id: staff.discord_id, created_at: at, submitted_at: null, read_by: null, read_at: null };
          state.evaluations.push(row);
        }
        const wasSent = row.status === 'enviada';
        Object.assign(row, after, { id: row.id, evaluator_id: row.evaluator_id, updated_at: at });
        if (row.status === 'enviada') {
          row.submitted_at = row.submitted_at ?? at;
          if (wasSent) { row.read_by = null; row.read_at = null; }
          if (!wasSent) audit(staff, 'avaliacao', row.id, 'enviada', null, { evaluated_id: row.evaluated_id, evaluator_id: row.evaluator_id, period_id: row.period_id });
        }
        save();
        return ok(presentEvaluation(row));
      });
    },

    async deleteEvaluation(id) {
      return run('deleteEvaluation', 'staff', async ({ staff }) => {
        const idx = state.evaluations.findIndex((e) => e.id === id && e.evaluator_id === staff.discord_id && e.status === 'rascunho');
        if (idx < 0) return fail('NOT_FOUND', 'Rascunho não encontrado.');
        state.evaluations.splice(idx, 1);
        save();
        return ok(null);
      });
    },

    async markEvaluationRead(id) {
      return run('markEvaluationRead', 'avaliacoes.ler', async ({ staff }) => {
        const e = state.evaluations.find((x) => x.id === id);
        if (e && e.status === 'enviada' && !e.read_at && e.evaluated_id !== staff.discord_id) {
          Object.assign(e, { read_by: staff.discord_id, read_at: nowIso() });
          save();
        }
        return ok(null);
      });
    },

    async archiveEvaluation(id) {
      return run('archiveEvaluation', 'avaliacoes.gerenciar', async ({ staff }) => {
        const e = state.evaluations.find((x) => x.id === id && x.status === 'enviada' && x.evaluated_id !== staff.discord_id);
        if (!e) return fail('NOT_FOUND', 'Avaliação não encontrada.');
        Object.assign(e, { status: 'arquivada', archived_by: staff.discord_id, archived_at: nowIso() });
        audit(staff, 'avaliacao', e.id, 'arquivada', null, { evaluated_id: e.evaluated_id, evaluator_id: e.evaluator_id, period_id: e.period_id });
        save();
        return ok(null);
      });
    },

    async eraseEvaluation(id, reason) {
      return run('eraseEvaluation', 'avaliacoes.apagar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const idx = state.evaluations.findIndex((e) => e.id === id);
        if (idx < 0) return fail('NOT_FOUND', APAGAR_ERRORS.evaluation);
        if (state.evaluations[idx].status === 'rascunho') return validationError({ _: APAGAR_ERRORS.evaluationDraft });
        const [row] = state.evaluations.splice(idx, 1);
        const decisoes = (state.evalDecisions ?? []).filter((d) => d.evaluation_id === id);
        state.evalDecisions = (state.evalDecisions ?? []).filter((d) => d.evaluation_id !== id);
        auditApagar(staff, 'avaliacao', id, 'apagada', { ...clone(row), decisoes: clone(decisoes) }, r.reason);
        save();
        return ok(null);
      });
    },

    /* ----- Plano 12: decisões da Direção, cobertura e lembretes ----- */
    async listEvaluationDecisions() {
      // Ao contrário da ordem de gravação antes de ordenar: no mesmo milissegundo, a mais recente vem primeiro.
      return run('listEvaluationDecisions', 'diretoria.ver', async ({ staff }) => ok([...(state.evalDecisions ?? [])].reverse()
        .filter((d) => d.evaluated_id !== staff.discord_id)
        .sort((a, b) => b.decided_at.localeCompare(a.decided_at))
        .map((d) => ({ ...clone(d), evaluated_name: nameOf(d.evaluated_id), decided_by_name: nameOf(d.decided_by) }))));
    },

    async registerEvaluationDecision(input = {}) {
      return run('registerEvaluationDecision', 'diretoria.ver', async ({ staff }) => {
        const ev = state.evaluations.find((e) => e.id === input.evaluation_id && e.status !== 'rascunho' && e.evaluated_id !== staff.discord_id);
        if (!ev) return fail('NOT_FOUND', EVALUATION_DECISION_ERRORS.notFound);
        const blocked = decisionTargetError(staff, state.staff.find((m) => m.discord_id === ev.evaluated_id) ?? null);
        if (blocked) return validationError({ _: blocked });
        const d = { decision: String(input.decision ?? ''), action: String(input.action ?? ''), reason: String(input.reason ?? '') };
        const { valid, errors } = validateDecision(ev, d);
        if (!valid) return validationError(errors);
        if (hasEmoji(d.reason)) return validationError({ reason: NO_EMOJI_MESSAGE });
        const row = {
          id: uuid(), evaluation_id: ev.id, evaluated_id: ev.evaluated_id, recommendation: ev.recommendation, decision: d.decision,
          action: resolvedAction(ev, d.decision, d.action), reason: d.reason.trim(), decided_by: staff.discord_id, decided_at: nowIso(),
        };
        (state.evalDecisions ??= []).push(row);
        save();
        return ok({ ...clone(row), evaluated_name: nameOf(row.evaluated_id), decided_by_name: nameOf(row.decided_by) });
      });
    },

    async getEvaluationCoverage(periodId) {
      return run('getEvaluationCoverage', 'staff', async ({ can }) => {
        if (!can('avaliacoes.ler') && !can('avaliacoes.gerenciar')) return fail('FORBIDDEN', EVALUATION_DECISION_ERRORS.coverage);
        return ok(state.staff
          .filter((m) => m.active && roleLevel(m.role) < 6 && permsOf(m).includes('avaliacoes.criar'))
          .sort(byStaffName)
          .map((m) => ({
            discord_id: m.discord_id, display_name: m.display_name, role: m.role,
            enviadas: state.evaluations.filter((e) => e.period_id === periodId && e.evaluator_id === m.discord_id && e.status !== 'rascunho').length,
          })));
      });
    },

    async listEvaluationReminders(periodId = '') {
      return run('listEvaluationReminders', 'staff', async ({ can }) => {
        if (!can('avaliacoes.ler') && !can('avaliacoes.gerenciar')) return fail('FORBIDDEN');
        return ok((state.evalReminders ?? []).filter((r) => !periodId || r.period_id === periodId)
          .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
          .map((r) => ({ ...clone(r), sent_by_name: nameOf(r.sent_by) })));
      });
    },

    /* Simula a ação 'lembrete_avaliacao' da Edge Function: mesmas travas, nada vai ao Discord de verdade; grava o registro. */
    async sendEvaluationReminder({ period_id: periodId, kind } = {}) {
      return run('sendEvaluationReminder', 'avaliacoes.gerenciar', async ({ staff }) => {
        if (!EVALUATION_REMINDER_KINDS.includes(kind)) return validationError({ _: EVALUATION_REMINDER_ERRORS.kind });
        const period = state.periods.find((p) => p.id === periodId);
        if (!period) return fail('NOT_FOUND', EVALUATION_REMINDER_ERRORS.period);
        if (new Date(period.ends_at).getTime() <= now().getTime()) return validationError({ _: EVALUATION_REMINDER_ERRORS.closed });
        const coverage = await adapter.getEvaluationCoverage(periodId);
        if (coverage.error) return coverage;
        const recipients = evaluationReminderRecipients(coverage.data, kind);
        if (!recipients.length) return validationError({ _: EVALUATION_REMINDER_ERRORS.noRecipients });
        const at = nowIso();
        const row = { id: uuid(), period_id: periodId, kind, sent: recipients.length, failed: [], sent_by: staff.discord_id, sent_at: at };
        (state.evalReminders ??= []).push(row);
        save();
        return ok({ sent_at: at, dm: { sent: recipients.length, failed: [] }, registrado: true });
      });
    },

    /* ----- Etapa 11: avisos ----- */
    async listAnnouncements() {
      return run('listAnnouncements', 'staff', async ({ staff, can }) => ok(state.announcements
        .filter((a) => can('avisos.enviar') || isAnnouncementFor(a, staff, now().getTime()))
        .sort((a, b) => b.starts_at.localeCompare(a.starts_at) || b.created_at.localeCompare(a.created_at))
        .map((a) => presentAnnouncement(a, staff))));
    },

    async saveAnnouncement(input = {}) {
      return run('saveAnnouncement', 'avisos.enviar', async ({ staff }) => {
        let row = input.id ? state.announcements.find((a) => a.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Aviso não encontrado.');
        const next = {
          title: String(input.title ?? row?.title ?? '').trim(), body: String(input.body ?? row?.body ?? ''),
          priority: input.priority ?? row?.priority ?? 'normal',
          audience_roles: [...new Set(input.audience_roles ?? row?.audience_roles ?? [])].sort(),
          starts_at: input.starts_at ?? row?.starts_at ?? nowIso(), ends_at: ('ends_at' in input ? input.ends_at : row?.ends_at) || null,
          requires_ack: Boolean(input.requires_ack ?? row?.requires_ack ?? false),
        };
        const { valid, errors } = validateAnnouncement(next);
        if (!valid) return validationError(errors);
        next.starts_at = new Date(next.starts_at).toISOString();
        if (next.ends_at) next.ends_at = new Date(next.ends_at).toISOString();
        if (!row) {
          row = { id: uuid(), created_by: staff.discord_id, created_at: nowIso() };
          state.announcements.push(row);
          audit(staff, 'aviso', row.id, 'criado', null, { title: next.title, priority: next.priority });
        }
        Object.assign(row, next, { updated_at: nowIso() });
        save();
        return ok(presentAnnouncement(row, staff));
      });
    },

    async deleteAnnouncement(id) {
      return run('deleteAnnouncement', 'avisos.enviar', async ({ staff }) => {
        const row = state.announcements.find((a) => a.id === id);
        if (!row) return fail('NOT_FOUND', 'Aviso não encontrado.');
        state.announcements = state.announcements.filter((a) => a.id !== id);
        state.reads = state.reads.filter((r) => r.announcement_id !== id);
        audit(staff, 'aviso', id, 'apagado', { title: row.title, priority: row.priority }, null);
        save();
        return ok(null);
      });
    },

    async markAnnouncementRead(id, { ack = false } = {}) {
      return run('markAnnouncementRead', 'staff', async ({ staff }) => {
        const a = state.announcements.find((x) => x.id === id);
        if (!a || !isAnnouncementFor(a, staff, now().getTime())) return fail('NOT_FOUND', 'Aviso não encontrado.');
        let r = state.reads.find((x) => x.announcement_id === id && x.discord_id === staff.discord_id);
        if (!r) { r = { announcement_id: id, discord_id: staff.discord_id, read_at: nowIso(), acknowledged_at: null }; state.reads.push(r); }
        if (ack && !r.acknowledged_at) r.acknowledged_at = nowIso();
        save();
        return ok(null);
      });
    },

    async getAnnouncementReport(id) {
      return run('getAnnouncementReport', 'avisos.enviar', async () => {
        const a = state.announcements.find((x) => x.id === id);
        if (!a) return fail('NOT_FOUND', 'Aviso não encontrado.');
        const rows = state.staff
          .filter((s) => s.active && (!a.audience_roles.length || a.audience_roles.includes(s.role)))
          .map((s) => {
            const r = state.reads.find((x) => x.announcement_id === id && x.discord_id === s.discord_id);
            return { discord_id: s.discord_id, display_name: s.display_name, role: s.role, read_at: r?.read_at ?? null, acknowledged_at: r?.acknowledged_at ?? null };
          })
          .sort((x, y) => (x.read_at ? 1 : 0) - (y.read_at ? 1 : 0) || byStaffName(x, y));
        return ok(rows);
      });
    },

    /* ----- Etapa 11: auditoria ----- */
    async listAudit({ entity = '', entityId = '', limit = 100, before = null } = {}) {
      return run('listAudit', 'auditoria.ver', async () => ok(state.audit
        .filter((a) => (!entity || a.entity === entity) && (!entityId || a.entity_id === entityId) && (before == null || a.id < before))
        .sort((a, b) => b.id - a.id)
        .slice(0, Math.min(Math.max(1, limit), 500))
        .map((a) => ({ ...clone(a), actor_name: nameOf(a.actor) }))));
    },

    /* ----- Etapa 5: gabarito, checklist e nomes proibidos ----- */
    async listInterviewQuestions({ includeInactive = false } = {}) {
      return run('listInterviewQuestions', 'staff', async ({ can }) => {
        if (!usesAllowlist(can)) return fail('FORBIDDEN', ALLOWLIST_ERRORS.forbidden);
        return ok(state.questions.filter((q) => includeInactive || q.active)
          .sort((a, b) => a.position - b.position).map(presentConfig));
      });
    },

    async listChecklistItems({ includeInactive = false } = {}) {
      return run('listChecklistItems', 'staff', async ({ can }) => {
        if (!usesAllowlist(can)) return fail('FORBIDDEN', ALLOWLIST_ERRORS.forbidden);
        return ok(state.checklistItems.filter((c) => includeInactive || c.active)
          .sort((a, b) => a.stage - b.stage || a.position - b.position).map(presentConfig));
      });
    },

    async listBlockedNames({ includeInactive = false } = {}) {
      return run('listBlockedNames', 'staff', async ({ can }) => {
        if (!usesAllowlist(can) && !can('lore.consultar')) return fail('FORBIDDEN');
        return ok(state.blockedNames.filter((n) => includeInactive || n.active)
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(presentConfig));
      });
    },

    /* ----- Etapa 5: análises de allowlist e entrevistas ----- */
    async listAlEvaluations({ kind = '', status = '', createdBy = '', query = '', limit = 100, before = null } = {}) {
      return run('listAlEvaluations', 'staff', async ({ staff, can }) => {
        const q = normalizeName(query);
        const hit = (e) => !q || [e.author_handle, e.player_discord_id, e.character_name, e.al_id].some((v) => normalizeName(v).includes(q));
        // Invertida antes de ordenar: no mesmo milissegundo, a criada por último vem primeiro.
        return ok([...state.alEvaluations].reverse()
          .filter((e) => seesEval(e, staff, can) && (!kind || e.kind === kind) && (!status || e.status === status)
            && (!createdBy || e.created_by === createdBy) && (!before || e.created_at < before) && hit(e))
          .sort(newestFirst)
          .slice(0, Math.min(Math.max(1, limit), 200))
          .map(presentEval));
      });
    },

    async getAlEvaluation(id) {
      return run('getAlEvaluation', 'staff', async ({ staff, can }) => {
        const e = state.alEvaluations.find((x) => x.id === id);
        return e && seesEval(e, staff, can) ? ok(detailOf(e)) : evalNotFound();
      });
    },

    async saveAlEvaluation(input = {}) {
      return run('saveAlEvaluation', 'allowlist.avaliar', async ({ staff, can }) => {
        const before = input.id ? state.alEvaluations.find((x) => x.id === input.id) : null;
        if (input.id && (!before || !seesEval(before, staff, can))) return evalNotFound();
        if (before && before.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (before?.sent_to_discord_at) return validationError({ _: ALLOWLIST_ERRORS.sent });
        const next = { ...(before ? clone(before) : { ...clone(AL_DEFAULTS), kind: input.kind }), ...pickAlEvaluation(input) };
        const { valid, errors } = validateAlEvaluation(next);
        const answers = Array.isArray(input.answers) ? pickAlAnswers(input.answers) : null;
        const participants = Array.isArray(input.participants) ? pickAlParticipants(input.participants, staff.discord_id) : null;
        const extras = validateAlExtras(next.kind, { answers, participants });
        if (!valid || !extras.valid) return validationError({ ...errors, ...extras.errors });
        const at = nowIso();
        let row = before;
        if (!row) {
          row = { id: uuid(), kind: next.kind, created_by: staff.discord_id, created_at: at, sent_to_discord_at: null, discord_status: '' };
          state.alEvaluations.push(row);
          state.alParticipants.push({ evaluation_id: row.id, discord_id: staff.discord_id, role: 'responsavel' });
        }
        Object.assign(row, pickAlEvaluation(next), { updated_at: at });
        if (answers) {
          state.alAnswers = state.alAnswers.filter((a) => a.evaluation_id !== row.id)
            .concat(answers.map((a) => ({ evaluation_id: row.id, ...a })));
        }
        if (participants) {
          state.alParticipants = state.alParticipants.filter((p) => p.evaluation_id !== row.id || p.role === 'responsavel')
            .concat(participants.map((p) => ({ evaluation_id: row.id, ...p })));
        }
        save();
        return ok(detailOf(row));
      });
    },

    async addAlPrint(evaluationId, file) {
      return run('addAlPrint', 'allowlist.avaliar', async ({ staff, can }) => {
        const e = state.alEvaluations.find((x) => x.id === evaluationId);
        if (!e || !seesEval(e, staff, can)) return evalNotFound();
        if (e.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (e.sent_to_discord_at) return validationError({ _: ALLOWLIST_ERRORS.sent });
        const used = state.alAttachments.filter((a) => a.evaluation_id === e.id);
        const bad = printError(file, used.length);
        if (bad) return validationError({ file: bad });
        const id = uuid();
        const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
        const position = [...Array(MAX_PRINTS).keys()].map((i) => i + 1).find((p) => !used.some((a) => a.position === p));
        const row = {
          id, evaluation_id: e.id, storage_path: `${e.id}/${id}.${ext}`, file_name: String(file.name ?? '').slice(0, 200),
          mime: file.type, size: file.size, position, created_by: staff.discord_id, created_at: nowIso(),
        };
        state.alAttachments.push(row);
        printFiles.set(row.storage_path, file);
        save();
        return ok(presentAttachment(row));
      });
    },

    async removeAlPrint(attachmentId) {
      return run('removeAlPrint', 'allowlist.avaliar', async ({ staff, can }) => {
        const a = state.alAttachments.find((x) => x.id === attachmentId);
        const e = a ? state.alEvaluations.find((x) => x.id === a.evaluation_id) : null;
        if (!e || !seesEval(e, staff, can)) return fail('NOT_FOUND', 'Print não encontrado.');
        if (e.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (e.sent_to_discord_at) return validationError({ _: ALLOWLIST_ERRORS.sent });
        state.alAttachments = state.alAttachments.filter((x) => x.id !== attachmentId);
        printFiles.delete(a.storage_path);
        save();
        return ok(null);
      });
    },

    async getAlPrintUrls(evaluationId) {
      return run('getAlPrintUrls', 'staff', async ({ staff, can }) => {
        const e = state.alEvaluations.find((x) => x.id === evaluationId);
        if (!e || !seesEval(e, staff, can)) return evalNotFound();
        return ok(state.alAttachments.filter((a) => a.evaluation_id === e.id).sort((a, b) => a.position - b.position)
          .map((a) => {
            const blob = printFiles.get(a.storage_path);
            const url = blob && globalThis.URL?.createObjectURL ? URL.createObjectURL(blob) : `mock://al-prints/${a.storage_path}`;
            return { id: a.id, url };
          }));
      });
    },

    /* ----- Etapa 5: webhooks do Discord (a url nunca sai) ----- */
    async listDiscordWebhooks({ purpose = '' } = {}) {
      return run('listDiscordWebhooks', 'staff', async ({ can }) => ok(state.webhooks
        .filter((w) => seesWebhook(w, can) && (!purpose || w.purpose === purpose))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        .map(presentWebhook)));
    },

    async saveDiscordWebhook(input = {}) {
      return run('saveDiscordWebhook', 'webhooks.gerenciar', async ({ staff }) => {
        const row = input.id ? state.webhooks.find((w) => w.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Webhook não encontrado.');
        const patch = pickWebhook(input);
        const next = { channel_name: '', sender_name: '', sender_avatar_url: '', active: true, ...(row ? presentWebhook(row) : {}), ...patch };
        const { valid, errors } = validateWebhook(next, { creating: !row });
        if (!valid) return validationError(errors);
        const cols = ['name', 'purpose', 'channel_name', 'sender_name', 'active'];
        const snap = (w) => Object.fromEntries(cols.map((c) => [c, w[c]]));
        const before = row ? snap(row) : null;
        const at = nowIso();
        const target = row ?? { id: uuid(), created_by: staff.discord_id, created_at: at };
        const urlChanged = Boolean(row && next.url && next.url !== row.url);
        Object.assign(target, {
          name: next.name, url: next.url ?? row?.url, purpose: next.purpose, channel_name: next.channel_name,
          sender_name: next.sender_name, sender_avatar_url: next.sender_avatar_url, active: next.active,
          updated_by: staff.discord_id, updated_at: at,
        });
        if (!row) state.webhooks.push(target);
        const after = { ...snap(target), ...(urlChanged ? { endereco_trocado: true } : {}) };
        if (!row || JSON.stringify(before) !== JSON.stringify(after)) {
          audit(staff, 'webhook', target.id, !row ? 'cadastrado' : before.active !== target.active ? (target.active ? 'ativado' : 'desativado') : 'alterado', before, after);
        }
        save();
        return ok(presentWebhook(target));
      });
    },

    async deleteDiscordWebhook(id) {
      return run('deleteDiscordWebhook', 'webhooks.gerenciar', async ({ staff }) => {
        const row = state.webhooks.find((w) => w.id === id);
        if (!row) return fail('NOT_FOUND', 'Webhook não encontrado.');
        state.webhooks = state.webhooks.filter((w) => w.id !== id);
        audit(staff, 'webhook', id, 'removido', { name: row.name, purpose: row.purpose, channel_name: row.channel_name, sender_name: row.sender_name, active: row.active }, null);
        save();
        return ok(null);
      });
    },

    /* ----- Etapa 8: gabarito, checklist e nomes proibidos (lore.gerenciar) ----- */
    async saveInterviewQuestion(input = {}) {
      return run('saveInterviewQuestion', 'lore.gerenciar', async ({ staff }) => saveConfig(staff, state.questions, input,
        QUESTION_FIELDS, validateQuestion, { extra_note: '', answer: '', active: true }, (row, before) => {
          if (!before || before.question !== row.question || before.active !== row.active) {
            audit(staff, 'pergunta', row.id, !before ? 'cadastrada' : before.active !== row.active ? (row.active ? 'ativada' : 'desativada') : 'alterada',
              before && { question: before.question, active: before.active }, { question: row.question, active: row.active });
          }
        }));
    },

    async saveChecklistItem(input = {}) {
      return run('saveChecklistItem', 'lore.gerenciar', async ({ staff }) => saveConfig(staff, state.checklistItems, input,
        CHECKLIST_FIELDS, validateChecklistItem, { hint: '', active: true }, (row, before) => {
          if (!before || before.text !== row.text || before.active !== row.active) {
            audit(staff, 'checklist', row.id, !before ? 'cadastrado' : before.active !== row.active ? (row.active ? 'ativado' : 'desativado') : 'alterado',
              before && { text: before.text, active: before.active }, { text: row.text, active: row.active });
          }
        }));
    },

    async deleteInterviewQuestion(id, reason) {
      return run('deleteInterviewQuestion', 'gabarito.apagar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const idx = state.questions.findIndex((q) => q.id === id);
        if (idx < 0) return fail('NOT_FOUND', APAGAR_ERRORS.question);
        const [row] = state.questions.splice(idx, 1);
        for (const a of state.alAnswers) if (a.question_id === id) a.question_id = null;
        auditApagar(staff, 'pergunta', id, 'apagada', clone(row), r.reason);
        save();
        return ok(null);
      });
    },

    async deleteChecklistItem(id, reason) {
      return run('deleteChecklistItem', 'gabarito.apagar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const idx = state.checklistItems.findIndex((c) => c.id === id);
        if (idx < 0) return fail('NOT_FOUND', APAGAR_ERRORS.item);
        const [row] = state.checklistItems.splice(idx, 1);
        auditApagar(staff, 'checklist', id, 'apagado', clone(row), r.reason);
        save();
        return ok(null);
      });
    },

    async saveBlockedName(input = {}) {
      return run('saveBlockedName', 'lore.gerenciar', async ({ staff }) => {
        const row = input.id ? state.blockedNames.find((n) => n.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Nome não encontrado.');
        if (row?.reason === 'em_uso' || (!row && input.reason === 'em_uso')) return validationError({ _: ALLOWLIST_ERRORS.nameInUse });
        const next = { series: '', reason_text: '', mode: 'bloqueia', active: true, ...(row ?? {}), ...pickFields(input, BLOCKED_NAME_FIELDS) };
        const { valid, errors } = validateBlockedName(next);
        if (!valid) return validationError(errors);
        const norm = normalizeName(next.name);
        if (next.active && state.blockedNames.some((n) => n.active && n.id !== row?.id && n.kind === next.kind && n.name_norm === norm
          && n.reason === next.reason && n.series === next.series)) return validationError({ name: ALLOWLIST_ERRORS.nameDuplicate });
        const cols = ['name', 'kind', 'reason', 'series', 'reason_text', 'mode', 'active'];
        const snap = (n) => Object.fromEntries(cols.map((c) => [c, n[c]]));
        const before = row ? snap(row) : null;
        const at = nowIso();
        const target = row ?? { id: uuid(), character_id: null, created_by: staff.discord_id, created_at: at };
        Object.assign(target, snap(next), { name_norm: norm, updated_by: staff.discord_id, updated_at: at });
        if (!row) state.blockedNames.push(target);
        if (!row || JSON.stringify(before) !== JSON.stringify(snap(target))) {
          audit(staff, 'nome_proibido', target.id, !row ? 'cadastrado' : before.active !== target.active ? (target.active ? 'ativado' : 'desativado') : 'alterado', before, snap(target));
        }
        save();
        return ok(presentConfig(target));
      });
    },

    /* ----- Etapa 9: personagens em uso ----- */
    async listCharacters() {
      return run('listCharacters', 'staff', async ({ can }) => {
        if (!seesLore(can)) return fail('FORBIDDEN');
        return ok(state.characters.map(presentCharacter).sort((a, b) => a.character_name.localeCompare(b.character_name, 'pt-BR')));
      });
    },

    async getCharacter(id) {
      return run('getCharacter', 'staff', async ({ can }) => {
        if (!seesLore(can)) return fail('FORBIDDEN');
        const c = state.characters.find((x) => x.id === id);
        if (!c) return fail('NOT_FOUND', 'Personagem não encontrado.');
        const notes = can('lore.anotacoes')
          ? state.characterNotes.filter((n) => n.character_id === c.id || (n.about === 'player' && n.player_discord_id === c.discord_id))
            .sort((a, b) => b.created_at.localeCompare(a.created_at)).map(presentNote)
          : [];
        const revisions = state.characterRevisions.filter((r) => r.character_id === c.id).sort((a, b) => b.version - a.version)
          .map((r) => ({ ...clone(r), changed_by_name: nameOf(r.changed_by) }));
        return ok({ ...presentCharacter(c), revisions, notes });
      });
    },

    async saveCharacter(input = {}) {
      return run('saveCharacter', 'lore.gerenciar', async ({ staff }) => {
        const row = input.id ? state.characters.find((c) => c.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Personagem não encontrado.');
        const next = { status: 'ativo', ...(row ? pickCharacter(row) : {}), ...pickCharacter(input) };
        const { valid, errors } = validateCharacter(next);
        if (!valid) return validationError(errors);
        const norm = normalizeName(next.character_name);
        const others = state.characters.filter((c) => c.id !== row?.id && c.status !== 'liberado');
        if (next.status !== 'liberado') {
          if (others.some((c) => normalizeName(c.character_name) === norm)) return validationError({ character_name: LORE_ERRORS.duplicateCharacter });
          if (others.some((c) => c.city_id === next.city_id)) return validationError({ city_id: LORE_ERRORS.duplicateCityId });
        }
        const at = nowIso();
        if (row) {
          const changed = Object.keys(next).some((k) => next[k] !== row[k]);
          if (!changed) return ok(presentCharacter(row));
          const { photo_url, ...old } = clone(row);
          state.characterRevisions.push({ id: uuid(), character_id: row.id, version: row.version, data: old, changed_by: staff.discord_id, changed_at: at });
          audit(staff, 'personagem', row.id, row.status !== next.status ? `situação: ${next.status}` : 'alterado',
            { character_name: row.character_name, discord_id: row.discord_id, city_id: row.city_id, status: row.status },
            { character_name: next.character_name, discord_id: next.discord_id, city_id: next.city_id, status: next.status });
          Object.assign(row, next, { version: row.version + 1, updated_by: staff.discord_id, updated_at: at });
        } else {
          const c = { id: uuid(), ...next, photo_path: null, version: 1, created_by: staff.discord_id, created_at: at, updated_by: staff.discord_id, updated_at: at };
          state.characters.push(c);
          audit(staff, 'personagem', c.id, 'cadastrado', null,
            { character_name: c.character_name, discord_id: c.discord_id, city_id: c.city_id, status: c.status });
        }
        const target = row ?? state.characters.at(-1);
        syncCharacterName(target, staff);
        save();
        return ok(presentCharacter(target));
      });
    },

    async deleteCharacter(id, reason) {
      return run('deleteCharacter', 'personagens.apagar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const row = state.characters.find((c) => c.id === id);
        if (!row) return fail('NOT_FOUND', APAGAR_ERRORS.character);
        const before = {
          character_name: row.character_name, discord_name: row.discord_name, discord_id: row.discord_id, city_id: row.city_id, status: row.status,
          photo_path: row.photo_path ?? null, version: row.version, created_by: row.created_by, created_at: row.created_at,
          anotacoes: state.characterNotes.filter((n) => n.character_id === id).length,
          alteracoes: state.characterRevisions.filter((x) => x.character_id === id).length,
        };
        // "Liberado" solta o nome e o ID da Cidade e desativa o nome proibido; depois o personagem sai da lista.
        Object.assign(row, { status: 'liberado', version: row.version + 1, updated_by: staff.discord_id, updated_at: nowIso() });
        syncCharacterName(row, staff);
        state.characters = state.characters.filter((c) => c.id !== id);
        auditApagar(staff, 'personagem', id, 'removido', before, r.reason);
        save();
        return ok(null);
      });
    },

    async setCharacterPhoto(id, file) {
      return run('setCharacterPhoto', 'lore.gerenciar', async ({ staff }) => {
        const c = state.characters.find((x) => x.id === id);
        if (!c) return fail('NOT_FOUND', 'Personagem não encontrado.');
        if (file) {
          const bad = photoError(file);
          if (bad) return validationError({ file: bad });
        }
        if (c.photo_path) photoFiles.delete(c.photo_path);
        const path = file ? `${id}/${uuid()}.${file.type.split('/')[1].replace('jpeg', 'jpg')}` : null;
        if (path) photoFiles.set(path, file);
        Object.assign(c, { photo_path: path, version: c.version + 1, updated_by: staff.discord_id, updated_at: nowIso() });
        save();
        return ok(presentCharacter(c));
      });
    },

    async addCharacterNote(characterId, input = {}) {
      return run('addCharacterNote', 'lore.anotacoes', async ({ staff }) => {
        const c = state.characters.find((x) => x.id === characterId);
        if (!c) return fail('NOT_FOUND', 'Personagem não encontrado.');
        const next = { about: String(input.about ?? ''), body: String(input.body ?? '').trim() };
        const { valid, errors } = validateCharacterNote(next);
        if (!valid) return validationError(errors);
        const n = { id: uuid(), character_id: c.id, ...next, player_discord_id: c.discord_id, created_by: staff.discord_id, created_at: nowIso() };
        state.characterNotes.push(n);
        save();
        return ok(presentNote(n));
      });
    },

    async deleteCharacterNote(id) {
      return run('deleteCharacterNote', 'lore.anotacoes', async ({ staff }) => {
        const n = state.characterNotes.find((x) => x.id === id && x.created_by === staff.discord_id);
        if (!n) return fail('NOT_FOUND', 'Anotação não encontrada.');
        state.characterNotes = state.characterNotes.filter((x) => x !== n);
        save();
        return ok(null);
      });
    },

    /* ----- Livro de Regras (regras.ler / regras.editar) ----- */
    async listRules() {
      return run('listRules', 'staff', async ({ can }) => {
        if (!can('regras.ler') && !can('regras.editar')) return fail('FORBIDDEN');
        return ok(sortRules(state.rules).map(presentRule));
      });
    },

    async saveRule(input = {}) {
      return run('saveRule', 'regras.editar', async ({ staff }) => {
        const row = input.id ? state.rules.find((x) => x.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Regra não encontrada.');
        const next = { position: 0, ...(row ? pickRule(row) : {}), ...pickRule(input) };
        const { valid, errors } = validateRule(next);
        if (!valid) return validationError(errors);
        if (state.rules.some((x) => x.id !== row?.id && x.category === next.category && x.title.toLowerCase() === next.title.toLowerCase())) {
          return validationError({ title: RULE_ERRORS.duplicate });
        }
        const at = nowIso();
        if (row) Object.assign(row, next, { updated_by: staff.discord_id, updated_at: at });
        const saved = row ?? { id: uuid(), ...next, created_by: staff.discord_id, created_at: at, updated_by: staff.discord_id, updated_at: at };
        if (!row) state.rules.push(saved);
        save();
        return ok(presentRule(saved));
      });
    },

    async deleteRule(id) {
      return run('deleteRule', 'regras.editar', async () => {
        const row = state.rules.find((x) => x.id === id);
        if (!row) return fail('NOT_FOUND', 'Regra não encontrada.');
        state.rules = state.rules.filter((x) => x !== row);
        save();
        return ok(null);
      });
    },

    /* ----- Agenda de Reuniões (agenda.ler / agenda.gerenciar) ----- */
    async listMeetings() {
      return run('listMeetings', 'staff', async ({ can }) => {
        if (!can('agenda.ler') && !can('agenda.gerenciar')) return fail('FORBIDDEN');
        return ok(sortMeetings(state.meetings).map(presentMeeting));
      });
    },

    async saveMeeting(input = {}) {
      return run('saveMeeting', 'agenda.gerenciar', async ({ staff }) => {
        const row = input.id ? state.meetings.find((x) => x.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Reunião não encontrada.');
        const next = { participants: [], ...(row ? pickMeeting(row) : {}), ...pickMeeting(input) };
        const { valid, errors } = validateMeeting(next);
        if (!valid) return validationError(errors);
        const fields = { ...next, starts_at: new Date(next.starts_at).toISOString() };
        const clash = findMeetingConflict({ id: row?.id, ...fields }, state.meetings, state.staff);
        if (clash) return validationError({ starts_at: meetingConflictMessage(clash.title) });
        const at = nowIso();
        if (row) Object.assign(row, fields, { updated_by: staff.discord_id, updated_at: at });
        const saved = row ?? { id: uuid(), ...fields, status: 'agendada', created_by: staff.discord_id, created_at: at, updated_by: staff.discord_id, updated_at: at };
        if (!row) state.meetings.push(saved);
        save();
        return ok(presentMeeting(saved));
      });
    },

    async checkMeetingConflict(input = {}) {
      return run('checkMeetingConflict', 'agenda.gerenciar', async () => {
        const next = pickMeeting(input);
        if (!next.starts_at || Number.isNaN(Date.parse(next.starts_at))) return ok(null);
        const clash = findMeetingConflict({ id: input.id, starts_at: new Date(next.starts_at).toISOString(), participants: next.participants ?? [] }, state.meetings, state.staff);
        return ok(clash ? clash.title : null);
      });
    },

    async deleteMeeting(id) {
      return run('deleteMeeting', 'agenda.gerenciar', async () => {
        const row = state.meetings.find((x) => x.id === id);
        if (!row) return fail('NOT_FOUND', 'Reunião não encontrada.');
        state.meetings = state.meetings.filter((x) => x !== row);
        save();
        return ok(null);
      });
    },

    /* ----- Áreas da Staff (19_areas.sql; regras em js/core/areas.js) ----- */
    async listMyAreas() {
      return run('listMyAreas', 'staff', async ({ staff }) => {
        const mine = state.areaMembers.filter((m) => m.discord_id === staff.discord_id);
        const cards = mine.map((m) => areaCard(state.areas.find((a) => a.id === m.area_id), m.papel)).filter(Boolean);
        return ok(cards.sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR')));
      });
    },

    async getArea(slug) {
      return run('getArea', 'staff', async ({ staff, can }) => {
        const area = state.areas.find((a) => a.slug === slug);
        const seen = area && areaView(area, staff, can);
        if (!seen) return fail('NOT_FOUND', AREA_ERRORS.notFound);
        return ok({ ...clone(area), papel: seen.papel });
      });
    },

    async listEligibleAreas() {
      return run('listEligibleAreas', 'staff', async ({ staff }) => ok(state.areas
        .filter((a) => a.status === 'ativa' && a.nivel_minimo <= roleLevel(staff.role))
        .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR'))
        .map((a) => ({
          id: a.id, nome: a.nome, descricao: a.descricao, cor: a.cor, icone: a.icone, nivel_minimo: a.nivel_minimo,
          ja_membro: state.areaMembers.some((m) => m.area_id === a.id && m.discord_id === staff.discord_id),
        }))));
    },

    async joinArea(areaId) {
      return run('joinArea', 'staff', async ({ staff }) => {
        const area = state.areas.find((a) => a.id === areaId);
        if (!area || area.status !== 'ativa' || area.nivel_minimo > roleLevel(staff.role)) return validationError({ _: AREA_ERRORS.notEligible });
        if (!state.areaMembers.some((m) => m.area_id === areaId && m.discord_id === staff.discord_id)) {
          const row = { area_id: areaId, discord_id: staff.discord_id, papel: 'membro', entrou_em: nowIso() };
          state.areaMembers.push(row);
          logArea(staff, area, 'insert', 'areas_membros', staff.discord_id, row);
          save();
        }
        return ok(null);
      });
    },

    async leaveArea(areaId) {
      return run('leaveArea', 'staff', async ({ staff }) => {
        const row = state.areaMembers.find((m) => m.area_id === areaId && m.discord_id === staff.discord_id);
        if (row) {
          state.areaMembers = state.areaMembers.filter((m) => m !== row);
          logArea(staff, state.areas.find((a) => a.id === areaId), 'delete', 'areas_membros', staff.discord_id, row);
          save();
        }
        return ok(null);
      });
    },

    async listAreaTeam(areaId) {
      return run('listAreaTeam', 'staff', async ({ staff, can }) => {
        const area = state.areas.find((a) => a.id === areaId);
        if (!area || !areaView(area, staff, can)) return ok([]);
        return ok(state.areaMembers.filter((m) => m.area_id === areaId)
          .map((m) => ({ m, s: state.staff.find((x) => x.discord_id === m.discord_id) })).filter(({ s }) => s?.active)
          .map(({ m, s }) => ({ discord_id: m.discord_id, display_name: s.display_name, role: s.role, papel: m.papel, entrou_em: m.entrou_em }))
          .sort((a, b) => (b.papel === 'lider') - (a.papel === 'lider') || a.display_name.localeCompare(b.display_name, 'pt-BR')));
      });
    },

    async listAreaTags(areaId) {
      return run('listAreaTags', 'staff', async ({ staff, can }) => {
        const area = state.areas.find((a) => a.id === areaId);
        if (!area || !areaView(area, staff, can)) return ok([]);
        return ok(clone(state.areaTags.filter((t) => t.area_id === areaId)).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')));
      });
    },

    async listAreaProcedures(areaId) {
      return run('listAreaProcedures', 'staff', async ({ staff, can }) => {
        const area = state.areas.find((a) => a.id === areaId);
        if (!area || !areaView(area, staff, can)) return ok([]);
        return ok(state.areaProcedures.filter((p) => p.area_id === areaId).map(presentAreaProcedure));
      });
    },

    async saveAreaProcedure(areaId, input = {}) {
      return run('saveAreaProcedure', 'staff', async ({ staff, can }) => {
        const area = state.areas.find((a) => a.id === areaId);
        const seen = area && areaView(area, staff, can);
        if (!seen) return fail('FORBIDDEN');
        const row = input.id ? state.areaProcedures.find((p) => p.id === input.id && p.area_id === areaId) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        const access = areaProcedureAccess({
          papel: seen.papel, manager: can('areas.gerenciar'), authorId: row?.criado_por ?? null, myId: staff.discord_id,
        });
        if (row ? !access.edit : !access.create) return fail('FORBIDDEN');
        if (area.status !== 'ativa') return validationError({ _: AREA_ERRORS.archivedArea });
        const next = { titulo: '', conteudo: '', status: 'publicado', tags: [], ...(row ? pickAreaProcedure(row) : {}), ...pickAreaProcedure(input) };
        const { valid, errors } = validateAreaProcedure(next);
        if (!valid) return validationError(errors);
        if (!access.archive && (next.status === 'arquivado' || row?.status === 'arquivado')) return validationError({ _: AREA_ERRORS.archiveRestricted });
        if (next.tags.some((t) => !state.areaTags.some((g) => g.id === t && g.area_id === areaId))) return validationError({ _: AREA_ERRORS.foreignTag });
        const at = nowIso();
        const before = row ? clone(row) : null;
        const target = row ?? { id: uuid(), area_id: areaId, criado_por: staff.discord_id, criado_em: at };
        Object.assign(target, next, { atualizado_por: staff.discord_id, atualizado_em: at });
        if (!row) state.areaProcedures.push(target);
        logArea(staff, area, row ? 'update' : 'insert', 'areas_procedimentos', target.id, row ? { antes: before, depois: clone(target) } : target);
        save();
        return ok(presentAreaProcedure(target));
      });
    },

    async deleteAreaProcedure(id) {
      return run('deleteAreaProcedure', 'staff', async ({ staff, can }) => {
        const row = state.areaProcedures.find((p) => p.id === id);
        const area = row && state.areas.find((a) => a.id === row.area_id);
        const seen = area && areaView(area, staff, can);
        if (!seen) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        if (!(seen.papel === 'lider' || can('areas.gerenciar'))) return fail('FORBIDDEN');
        state.areaProcedures = state.areaProcedures.filter((p) => p !== row);
        logArea(staff, area, 'delete', 'areas_procedimentos', row.id, row);
        save();
        return ok(null);
      });
    },

    async listAreaHistory(areaId, { limit = 20, offset = 0 } = {}) {
      return run('listAreaHistory', 'staff', async ({ staff, can }) => {
        const area = state.areas.find((a) => a.id === areaId);
        const seen = area && areaView(area, staff, can);
        if (!seen || !(seen.papel === 'lider' || can('areas.gerenciar'))) return ok({ items: [], total: 0 });
        const all = state.areaHistory.filter((e) => e.area_id === areaId).sort((a, b) => b.id - a.id);
        return ok({ items: all.slice(offset, offset + limit).map((e) => ({ ...clone(e), ator_nome: nameOf(e.ator_id) })), total: all.length });
      });
    },

    /* ----- Áreas da Staff: painel de gestão (areas.gerenciar) ----- */
    async listAreas() {
      return run('listAreas', 'areas.gerenciar', async () => ok(clone(state.areas)
        .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR'))
        .map((a) => areaCard(a, null))));
    },

    async saveArea(input = {}) {
      return run('saveArea', 'areas.gerenciar', async ({ staff }) => {
        const row = input.id ? state.areas.find((a) => a.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Área não encontrada.');
        const picked = pickArea(input);
        const slug = row ? row.slug : (picked.slug || areaSlug(picked.nome ?? '', state.areas.map((a) => a.slug)));
        const next = {
          descricao: null, icone: null, cor: DEFAULT_AREA_COLOR, nivel_minimo: 1, status: 'ativa', discord_role_id: null, discord_canal_id: null,
          ordem: Math.max(0, ...state.areas.map((a) => a.ordem)) + 1, ...(row ? pickArea(row) : {}), ...picked, slug,
        };
        const { valid, errors } = validateArea(next);
        if (!valid) return validationError(errors);
        if (state.areas.some((a) => a.id !== row?.id && a.slug === slug)) return validationError({ slug: AREA_MANAGE_ERRORS.slugTaken });
        const at = nowIso();
        const before = row ? clone(row) : null;
        const target = row ?? { id: uuid(), criado_por: staff.discord_id, criado_em: at };
        Object.assign(target, next, { atualizado_em: at });
        if (!row) state.areas.push(target);
        logArea(staff, target, row ? 'update' : 'insert', 'areas', target.id, row ? { antes: before, depois: clone(target) } : target);
        save();
        return ok(areaCard(target, null));
      });
    },

    async reorderAreas(ids = []) {
      return run('reorderAreas', 'areas.gerenciar', async ({ staff }) => {
        ids.forEach((id, i) => {
          const area = state.areas.find((a) => a.id === id);
          if (!area || area.ordem === i + 1) return;
          const before = clone(area);
          Object.assign(area, { ordem: i + 1, atualizado_em: nowIso() });
          logArea(staff, area, 'update', 'areas', area.id, { antes: before, depois: clone(area) });
        });
        save();
        return ok(null);
      });
    },

    async deleteArea(id) {
      return run('deleteArea', 'areas.gerenciar', async ({ staff }) => {
        const area = state.areas.find((a) => a.id === id);
        if (!area) return fail('NOT_FOUND', 'Área não encontrada.');
        state.areas = state.areas.filter((a) => a !== area);
        for (const key of ['areaMembers', 'areaTags', 'areaProcedures']) state[key] = state[key].filter((x) => x.area_id !== id);
        logArea(staff, area, 'delete', 'areas', area.id, area);
        save();
        return ok(null);
      });
    },

    async addAreaMember(areaId, discordId, papel = 'membro') {
      return run('addAreaMember', 'areas.gerenciar', async ({ staff }) => {
        const area = state.areas.find((a) => a.id === areaId);
        if (!area) return fail('NOT_FOUND', 'Área não encontrada.');
        if (!AREA_ROLES.includes(papel)) return validationError({ papel: AREA_MANAGE_ERRORS.role });
        if (!state.staff.some((s) => s.discord_id === discordId)) return validationError({ discord_id: AREA_MANAGE_ERRORS.member });
        if (state.areaMembers.some((m) => m.area_id === areaId && m.discord_id === discordId)) return validationError({ _: AREA_MANAGE_ERRORS.alreadyMember });
        const row = { area_id: areaId, discord_id: discordId, papel, entrou_em: nowIso() };
        state.areaMembers.push(row);
        logArea(staff, area, 'insert', 'areas_membros', discordId, row);
        save();
        return ok(null);
      });
    },

    async setAreaMemberRole(areaId, discordId, papel) {
      return run('setAreaMemberRole', 'areas.gerenciar', async ({ staff }) => {
        if (!AREA_ROLES.includes(papel)) return validationError({ papel: AREA_MANAGE_ERRORS.role });
        const row = state.areaMembers.find((m) => m.area_id === areaId && m.discord_id === discordId);
        if (!row) return fail('NOT_FOUND', 'Membro não encontrado nesta área.');
        const before = clone(row);
        row.papel = papel;
        logArea(staff, state.areas.find((a) => a.id === areaId), 'update', 'areas_membros', discordId, { antes: before, depois: clone(row) });
        save();
        return ok(null);
      });
    },

    async removeAreaMember(areaId, discordId) {
      return run('removeAreaMember', 'areas.gerenciar', async ({ staff }) => {
        const row = state.areaMembers.find((m) => m.area_id === areaId && m.discord_id === discordId);
        if (!row) return fail('NOT_FOUND', 'Membro não encontrado nesta área.');
        state.areaMembers = state.areaMembers.filter((m) => m !== row);
        logArea(staff, state.areas.find((a) => a.id === areaId), 'delete', 'areas_membros', discordId, row);
        save();
        return ok(null);
      });
    },

    async listMembersWithoutArea() {
      return run('listMembersWithoutArea', 'areas.gerenciar', async () => ok(state.staff
        .filter((s) => s.active && !state.areaMembers.some((m) => m.discord_id === s.discord_id))
        .map((s) => ({ discord_id: s.discord_id, display_name: s.display_name, role: s.role }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'))));
    },

    async saveAreaTag(areaId, input = {}) {
      return run('saveAreaTag', 'areas.gerenciar', async ({ staff }) => {
        const area = state.areas.find((a) => a.id === areaId);
        if (!area) return fail('NOT_FOUND', 'Área não encontrada.');
        const row = input.id ? state.areaTags.find((t) => t.id === input.id && t.area_id === areaId) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Tag não encontrada.');
        const next = { nome: '', cor: DEFAULT_TAG_COLOR, discord_role_id: null, ...(row ? pickAreaTag(row) : {}), ...pickAreaTag(input) };
        const { valid, errors } = validateAreaTag(next);
        if (!valid) return validationError(errors);
        if (state.areaTags.some((t) => t.area_id === areaId && t.id !== row?.id && t.nome === next.nome)) return validationError({ nome: AREA_MANAGE_ERRORS.tagTaken });
        const before = row ? clone(row) : null;
        const target = row ?? { id: uuid(), area_id: areaId };
        Object.assign(target, next);
        if (!row) state.areaTags.push(target);
        logArea(staff, area, row ? 'update' : 'insert', 'areas_tags', target.id, row ? { antes: before, depois: clone(target) } : target);
        save();
        return ok(clone(target));
      });
    },

    async deleteAreaTag(id) {
      return run('deleteAreaTag', 'areas.gerenciar', async ({ staff }) => {
        const tag = state.areaTags.find((t) => t.id === id);
        if (!tag) return fail('NOT_FOUND', 'Tag não encontrada.');
        const area = state.areas.find((a) => a.id === tag.area_id);
        if (area?.status !== 'ativa' && state.areaProcedures.some((p) => p.tags.includes(id))) return validationError({ _: AREA_ERRORS.archivedArea });
        // Como o site de verdade: tira a tag dos procedimentos antes (o banco recusa tag que não existe mais).
        for (const p of state.areaProcedures) if (p.tags.includes(id)) p.tags = p.tags.filter((t) => t !== id);
        state.areaTags = state.areaTags.filter((t) => t !== tag);
        logArea(staff, area, 'delete', 'areas_tags', id, tag);
        save();
        return ok(null);
      });
    },

    async listAllAreaHistory({ areaId = '', actorId = '', acao = '', from = '', to = '', limit = 20, offset = 0 } = {}) {
      return run('listAllAreaHistory', 'areas.gerenciar', async () => {
        const { start, end } = historyRange({ from, to });
        const all = state.areaHistory.filter((e) => (!areaId || e.area_id === areaId) && (!actorId || e.ator_id === actorId) && (!acao || e.acao === acao)
          && (!start || e.criado_em >= start) && (!end || e.criado_em < end)).sort((a, b) => b.id - a.id);
        return ok({ items: all.slice(offset, offset + limit).map((e) => ({ ...clone(e), ator_nome: nameOf(e.ator_id) })), total: all.length });
      });
    },

    async listAreaMessages(areaId = '', { limit = 20, offset = 0 } = {}) {
      return run('listAreaMessages', 'areas.gerenciar', async () => {
        const all = [...(state.areaComms ?? [])].reverse().filter((c) => !areaId || c.area_id === areaId).sort((a, b) => (a.criado_em < b.criado_em ? 1 : a.criado_em > b.criado_em ? -1 : 0));
        return ok({ items: all.slice(offset, offset + limit).map((c) => ({ ...clone(c), enviado_por_nome: nameOf(c.enviado_por) })), total: all.length });
      });
    },

    /* Simula a ação 'area' da Edge Function: mesmas travas, nada vai ao Discord de verdade; grava o transcrito e o histórico. */
    async sendAreaMessage(areaId, { tipo, conteudo, canal_id = '', user_ids = [], mencionar_cargo = false, link_call = '' } = {}) {
      return run('sendAreaMessage', 'areas.gerenciar', async ({ staff }) => {
        const check = validateAreaMessage({ kind: tipo, conteudo, canal_id, user_ids, link_call });
        if (!check.valid) return validationError(check.errors);
        const area = state.areas.find((a) => a.id === areaId);
        if (!area) return fail('NOT_FOUND', AREA_DISCORD_ERRORS.areaNotFound);
        if (area.status !== 'ativa') return validationError({ _: AREA_DISCORD_ERRORS.archived });
        const members = state.areaMembers.filter((m) => m.area_id === areaId)
          .map((m) => state.staff.find((s) => s.discord_id === m.discord_id)).filter((s) => s?.active);
        const { recipients, unknown } = areaRecipients(user_ids, members);
        if (unknown.length) return validationError({ _: AREA_DISCORD_ERRORS.notMembers });
        if (tipo !== 'canal' && !recipients.length) return validationError({ _: AREA_DISCORD_ERRORS.noRecipients });
        if (tipo !== 'dm' && mencionar_cargo === true && !area.discord_role_id) return validationError({ _: AREA_DISCORD_ERRORS.noRole });
        const channel = String(canal_id).trim() || area.discord_canal_id;
        if (tipo !== 'dm' && !channel) return validationError({ _: AREA_DISCORD_ERRORS.noChannel });
        if (tipo === 'alinhamento' && recipients.length > AREA_MAX_MENTIONS && !(mencionar_cargo === true)) return validationError({ _: AREA_DISCORD_ERRORS.tooManyMentions });
        const detalhes = tipo === 'canal' ? [] : recipients.map((r) => ({ discord_id: r.discord_id, nome: r.display_name, status: 'ok' }));
        const enviados = tipo === 'canal' ? 1 : detalhes.length;
        const text = String(conteudo).trim();
        const at = nowIso();
        const comm = { id: uuid(), area_id: areaId, area_nome: area.nome, tipo, canal_id: tipo === 'dm' ? null : channel, conteudo: text, destinatarios: detalhes, enviado_por: staff.discord_id, criado_em: at };
        (state.areaComms ??= []).push(comm);
        logArea(staff, area, AREA_HISTORY_ACTIONS[tipo], 'comunicacao', comm.id, { tipo, canal_id: comm.canal_id, enviados, falhas: 0, conteudo: text.slice(0, 300) });
        save();
        return ok({ sent_at: at, enviados, falhas: 0, detalhes: clone(detalhes), registrado: true });
      });
    },

    /* ----- Perfil da staff (20_perfil.sql; regras em js/core/perfil.js) ----- */
    async getProfile(discordId) {
      return run('getProfile', 'staff', async ({ staff, can }) => {
        const target = state.staff.find((x) => x.discord_id === String(discordId));
        const manager = can('equipe.gerenciar');
        const self = Boolean(target) && target.discord_id === staff.discord_id;
        if (!target || (!target.active && !manager && !self)) return fail('NOT_FOUND', PROFILE_ERRORS.notFound);
        const extra = (state.profiles ??= {})[target.discord_id] ?? {};
        if (extra.perfil_publico === false && !self && !manager) return ok({ privado: true });
        const sees = (areaId) => can('areas.gerenciar') || state.areaMembers.some((m) => m.area_id === areaId && m.discord_id === staff.discord_id);
        const areaOf = (id) => state.areas.find((a) => a.id === id);
        const mine = state.areaMembers.filter((m) => m.discord_id === target.discord_id && sees(m.area_id));
        const areas = mine.map((m) => ({ ...areaOf(m.area_id), papel: m.papel, entrou_em: m.entrou_em })).filter((a) => a.id)
          .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR'))
          .map((a) => ({ id: a.id, nome: a.nome, slug: a.slug, cor: a.cor, icone: a.icone, status: a.status, papel: a.papel, entrou_em: a.entrou_em }));
        const sawAgenda = can('agenda.ler') || can('agenda.gerenciar');
        const asRow = [{ ...target, active: true }];
        const covered = (m) => audienceOf(m.participants, asRow).has(target.discord_id);
        const meetings = sawAgenda ? state.meetings.filter((m) => m.created_by === target.discord_id || covered(m)) : [];
        const reunioes = sortMeetings(meetings).reverse().slice(0, 50).map((m) => ({
          id: m.id, title: m.title, description: m.description ?? null, starts_at: m.starts_at, status: m.status ?? 'agendada',
          relacao: m.created_by === target.discord_id ? 'criada' : 'convocado',
        }));
        const procs = state.areaProcedures.filter((p) => p.criado_por === target.discord_id && p.status !== 'arquivado'
          && (p.status === 'publicado' || self) && sees(p.area_id));
        const procedimentos = procs.sort((a, b) => b.atualizado_em.localeCompare(a.atualizado_em)).slice(0, 50).map((p) => {
          const area = areaOf(p.area_id);
          return { id: p.id, titulo: p.titulo, conteudo: p.conteudo, status: p.status, area_id: p.area_id, area_nome: area?.nome ?? '', area_slug: area?.slug ?? '', criado_em: p.criado_em, atualizado_em: p.atualizado_em };
        });
        const acoes = state.areaHistory.filter((e) => e.ator_id === target.discord_id && e.entidade !== 'comunicacao').length;
        return ok({
          discord_id: target.discord_id, display_name: target.display_name, role: target.role, level: roleLevel(target.role),
          teams: [...(target.teams ?? [])], active: target.active, entrou_em: target.created_at ?? null,
          bio: extra.bio ?? null, banner_color: extra.banner_color ?? '#8b0000', perfil_publico: extra.perfil_publico ?? true,
          avatar_url: extra.avatar_url ?? null, self, reunioes_visiveis: sawAgenda,
          stats: {
            reunioes_criadas: sawAgenda ? state.meetings.filter((m) => m.created_by === target.discord_id).length : null,
            reunioes_convocado: sawAgenda ? state.meetings.filter((m) => m.created_by !== target.discord_id && covered(m)).length : null,
            areas: state.areaMembers.filter((m) => m.discord_id === target.discord_id && areaOf(m.area_id)?.status === 'ativa').length,
            procedimentos: state.areaProcedures.filter((p) => p.criado_por === target.discord_id && p.status !== 'arquivado').length,
            acoes,
          },
          areas, reunioes, procedimentos,
        });
      });
    },

    async listProfileHistory(discordId, { limit = 20, offset = 0 } = {}) {
      return run('listProfileHistory', 'staff', async ({ staff, can }) => {
        const target = state.staff.find((x) => x.discord_id === String(discordId));
        if (!target) return ok({ items: [], total: 0 });
        const manager = can('equipe.gerenciar');
        const self = target.discord_id === staff.discord_id;
        const extra = (state.profiles ??= {})[target.discord_id] ?? {};
        if (extra.perfil_publico === false && !self && !manager) return ok({ items: [], total: 0 });
        const privileged = self || manager || can('areas.gerenciar');
        const all = state.areaHistory
          .filter((e) => e.ator_id === target.discord_id && (e.entidade !== 'comunicacao' || privileged)
            && (privileged || (e.area_id && state.areaMembers.some((m) => m.area_id === e.area_id && m.discord_id === staff.discord_id))))
          .sort((a, b) => b.id - a.id);
        const size = Math.max(1, Math.min(Number(limit) || 20, 100));
        const from = Math.max(0, Number(offset) || 0);
        const items = all.slice(from, from + size).map((e) => ({ id: e.id, acao: e.acao, entidade: e.entidade, area_nome: e.area_nome, criado_em: e.criado_em, nome: areaEventName(e) }));
        return ok({ items, total: all.length });
      });
    },

    async updateMyProfile(patch = {}) {
      return run('updateMyProfile', 'staff', async ({ staff }) => {
        const next = pickProfileEdit(patch);
        const { valid, errors } = validateProfileEdit(next);
        if (!valid) return validationError(errors);
        const row = ((state.profiles ??= {})[staff.discord_id] ??= {});
        if ('bio' in next) row.bio = next.bio || null;
        if ('banner_color' in next) row.banner_color = next.banner_color;
        if ('perfil_publico' in next) row.perfil_publico = next.perfil_publico;
        row.atualizado_em = nowIso();
        save();
        return ok(null);
      });
    },

    async syncMyAvatar(url) {
      return run('syncMyAvatar', 'staff', async ({ staff }) => {
        const clean = safeAvatar(url);
        if (!clean) return validationError({ _: PROFILE_ERRORS.avatar });
        const row = ((state.profiles ??= {})[staff.discord_id] ??= {});
        if (row.avatar_url !== clean) { row.avatar_url = clean; save(); }
        return ok(null);
      });
    },

    /* ----- Painel da Diretoria (21_diretoria.sql; regras em js/core/diretoria.js) ----- */
    async getDiretoriaMembers() {
      return run('getDiretoriaMembers', 'diretoria.ver', async () => {
        const evalsOf = (id) => state.dirEvaluations.filter((e) => e.avaliado_id === id).sort((a, b) => b.criado_em.localeCompare(a.criado_em));
        const list = state.staff.map((s) => {
          const evals = evalsOf(s.discord_id);
          const last3 = evals.slice(0, 3);
          const changes = state.roleHistory.filter((x) => x.membro_id === s.discord_id).map((x) => x.feito_em).sort();
          return {
            discord_id: s.discord_id, display_name: s.display_name, role: s.role, teams: [...(s.teams ?? [])], active: s.active,
            created_at: s.created_at ?? null, avatar_url: (state.profiles ?? {})[s.discord_id]?.avatar_url ?? null,
            areas: state.areaMembers.filter((m) => m.discord_id === s.discord_id)
              .map((m) => state.areas.find((a) => a.id === m.area_id)).filter((a) => a && a.status === 'ativa')
              .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR')).map((a) => ({ nome: a.nome, cor: a.cor })),
            media: last3.length ? Math.round((last3.reduce((n, e) => n + e.nota_geral, 0) / last3.length) * 10) / 10 : null,
            avaliacoes: evals.length, ultima_avaliacao: evals[0]?.criado_em ?? null,
            ocorrencias: state.occurrences.filter((o) => o.membro_id === s.discord_id).length,
            cargo_desde: changes.at(-1) ?? s.created_at ?? null,
          };
        });
        return ok(list.sort((a, b) => roleLevel(b.role) - roleLevel(a.role) || a.display_name.localeCompare(b.display_name, 'pt-BR')));
      });
    },

    async listDirectorEvaluations() {
      return run('listDirectorEvaluations', 'diretoria.ver', async () => ok(state.dirEvaluations
        .map((e) => ({ ...clone(e), avaliado_nome: nameOf(e.avaliado_id), avaliador_nome: nameOf(e.avaliador_id) }))
        .sort((a, b) => b.criado_em.localeCompare(a.criado_em))));
    },

    async saveDirectorEvaluation(input) {
      return run('saveDirectorEvaluation', 'diretoria.ver', async ({ staff }) => {
        const next = pickDirectorEvaluation(input);
        const target = state.staff.find((x) => x.discord_id === next.avaliado_id) ?? null;
        const errors = validateDirectorEvaluation(staff, target, next);
        if (next.area_id && !state.areas.some((a) => a.id === next.area_id)) errors.area_id = AREA_EVAL_ERRORS.area;
        if (Object.keys(errors).length) return validationError(errors);
        const row = { id: uuid(), ...next, comentario: next.comentario || null, avaliador_id: staff.discord_id, criado_em: nowIso() };
        state.dirEvaluations.push(row);
        save();
        return ok({ ...clone(row), avaliado_nome: nameOf(row.avaliado_id), avaliador_nome: nameOf(row.avaliador_id) });
      });
    },

    async listOccurrences() {
      return run('listOccurrences', 'diretoria.ver', async () => ok(state.occurrences
        .map((o) => ({ ...clone(o), membro_nome: nameOf(o.membro_id), feito_por_nome: nameOf(o.feito_por) }))
        .sort((a, b) => b.feito_em.localeCompare(a.feito_em))));
    },

    async deleteOccurrence(id, reason) {
      return run('deleteOccurrence', 'ocorrencias.apagar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const idx = state.occurrences.findIndex((o) => o.id === id);
        if (idx < 0) return fail('NOT_FOUND', APAGAR_ERRORS.occurrence);
        const [row] = state.occurrences.splice(idx, 1);
        auditApagar(staff, 'ocorrencia', id, 'apagada', clone(row), r.reason);
        save();
        return ok(null);
      });
    },

    async saveOccurrence(input = {}) {
      return run('saveOccurrence', 'diretoria.ver', async ({ staff }) => {
        const next = { membro_id: String(input?.membro_id ?? '').trim(), tipo: String(input?.tipo ?? ''), descricao: String(input?.descricao ?? '').trim() };
        const target = state.staff.find((x) => x.discord_id === next.membro_id) ?? null;
        const errors = validateOccurrence(staff, target, next);
        if (Object.keys(errors).length) return validationError(errors);
        const row = { id: uuid(), ...next, feito_por: staff.discord_id, feito_em: nowIso() };
        state.occurrences.push(row);
        save();
        return ok({ ...clone(row), membro_nome: nameOf(row.membro_id), feito_por_nome: nameOf(row.feito_por) });
      });
    },

    async listRoleHistory({ memberId = '', limit = 25, offset = 0 } = {}) {
      return run('listRoleHistory', 'diretoria.ver', async () => {
        const all = state.roleHistory.filter((x) => !memberId || x.membro_id === memberId)
          .sort((a, b) => b.feito_em.localeCompare(a.feito_em) || b.id - a.id);
        const size = Math.max(1, Math.min(Number(limit) || 25, 100));
        const from = Math.max(0, Number(offset) || 0);
        return ok({
          items: all.slice(from, from + size).map((x) => ({ ...clone(x), membro_nome: nameOf(x.membro_id), feito_por_nome: nameOf(x.feito_por) })),
          total: all.length,
        });
      });
    },

    async changeMemberRole(discordId, role, motivo = '') {
      return run('changeMemberRole', 'equipe.gerenciar', async ({ staff }) => {
        const member = state.staff.find((s) => s.discord_id === discordId);
        if (!member) return validationError({ _: DIRETORIA_ERRORS.member });
        const why = reasonError(motivo);
        if (why) return validationError({ motivo: why });
        if (!ROLE_CODES.includes(role)) return validationError({ role: DIRETORIA_ERRORS.roleUnknown });
        if (member.role === role) return validationError({ role: DIRETORIA_ERRORS.sameRole });
        const blocked = staffChangeError(staff, member, { ...member, role }, otherActiveCeos(discordId));
        if (blocked) return validationError({ _: blocked });
        const before = staffAudit(member);
        member.role = role;
        audit(staff, 'membro', discordId, 'alterado', before, staffAudit(member));
        logRoleChange(discordId, before.role, role, String(motivo ?? '').trim(), staff);
        save();
        return ok(presentStaff(member));
      });
    },

    async getDiretoriaActivity({ from, to } = {}) {
      return run('getDiretoriaActivity', 'diretoria.ver', async () => {
        const a = Date.parse(from);
        const b = Date.parse(to);
        if (!(b > a) || b - a > 400 * 86400_000) return validationError({ _: DIRETORIA_ERRORS.period400 });
        const acts = [];
        const add = (who, tipo, iso) => {
          const t = iso ? Date.parse(iso) : NaN;
          if (t >= a && t < b && state.staff.some((s) => s.discord_id === who)) acts.push({ who, tipo, iso });
        };
        for (const e of state.alEvaluations) {
          add(e.created_by, e.kind === 'allowlist' ? 'allowlist' : 'entrevista', e.created_at);
          if (e.kind !== 'entrevista') continue;
          for (const p of state.alParticipants) {
            if (p.evaluation_id === e.id && p.role !== 'acompanhante' && p.discord_id !== e.created_by) add(p.discord_id, 'entrevista', e.created_at);
          }
        }
        for (const p of state.procedures) add(p.created_by, 'procedimento', p.created_at);
        for (const p of state.areaProcedures) add(p.criado_por, 'procedimento', p.criado_em);
        for (const m of state.meetings) add(m.created_by, 'reuniao', m.created_at);
        for (const m of state.areaMembers) add(m.discord_id, 'area_entrada', m.entrou_em);
        for (const e of state.evaluations) add(e.evaluator_id, 'avaliacao_feita', e.submitted_at);
        for (const e of state.dirEvaluations) add(e.avaliador_id, 'avaliacao_feita', e.criado_em);
        for (const o of state.occurrences) add(o.membro_id, o.tipo, o.feito_em);
        const per = new Map();
        for (const x of acts) {
          const key = `${weekOf(x.iso)}|${x.who}|${x.tipo}`;
          per.set(key, (per.get(key) ?? 0) + 1);
        }
        const rows = [...per].map(([k, total]) => {
          const [semana, discord_id, tipo] = k.split('|');
          return { discord_id, tipo, semana, total };
        });
        return ok(rows.sort((x, y) => x.semana.localeCompare(y.semana) || x.discord_id.localeCompare(y.discord_id) || x.tipo.localeCompare(y.tipo)));
      });
    },

    async getPromotionRules() {
      return run('getPromotionRules', 'diretoria.ver', async () => {
        const r = state.promotionRules;
        return ok({ ...clone(r), atualizado_por_nome: r.atualizado_por ? nameOf(r.atualizado_por) : null });
      });
    },

    async savePromotionRules(conteudo) {
      return run('savePromotionRules', 'diretoria.gerenciar', async ({ staff }) => {
        const text = String(conteudo ?? '');
        const e = promotionRulesError(text);
        if (e) return validationError({ conteudo: e });
        state.promotionRules = { conteudo: text, atualizado_por: staff.discord_id, atualizado_em: nowIso() };
        save();
        return ok({ ...clone(state.promotionRules), atualizado_por_nome: nameOf(staff.discord_id) });
      });
    },

    async getDirectorScore(discordId) {
      return run('getDirectorScore', 'staff', async ({ staff, can }) => {
        if (String(discordId) !== staff.discord_id && !can('diretoria.ver')) return ok(null);
        const last3 = state.dirEvaluations.filter((e) => e.avaliado_id === String(discordId) && e.visivel_avaliado)
          .sort((a, b) => b.criado_em.localeCompare(a.criado_em)).slice(0, 3);
        if (!last3.length) return ok(null);
        return ok({ media: Math.round((last3.reduce((n, e) => n + e.nota_geral, 0) / last3.length) * 10) / 10, total: last3.length });
      });
    },

    /* ----- Plano 11: avaliações por área, no perfil e alinhamentos (22_diretoria_avaliacoes_alinhamento.sql) ----- */
    async getEvaluationsByArea({ days = 0 } = {}) {
      return run('getEvaluationsByArea', 'staff', async ({ can }) => {
        if (!can('diretoria.ver') && !can('diretoria.avaliacoes')) return fail('FORBIDDEN', AREA_EVAL_ERRORS.byAreaForbidden);
        const n = Number(days) || 0;
        const since = n > 0 ? Date.now() - n * 86400_000 : null;
        const list = state.dirEvaluations.filter((e) => since == null || Date.parse(e.criado_em) >= since);
        return ok(averagesByArea(list, state.areas, state.areaMembers));
      });
    },

    async listReceivedEvaluations(discordId) {
      return run('listReceivedEvaluations', 'staff', async ({ staff, can }) => {
        if (String(discordId) !== staff.discord_id && !can('diretoria.ver')) return ok(null);
        return ok(state.dirEvaluations.filter((e) => e.avaliado_id === String(discordId) && e.visivel_avaliado)
          .sort((a, b) => b.criado_em.localeCompare(a.criado_em)).slice(0, 50)
          .map((e) => receivedEvaluationView(e, state.areas.find((a) => a.id === e.area_id)?.nome ?? null)));
      });
    },

    /* Simula a ação 'alinhamento' da Edge Function: mesmas travas, nada vai ao Discord de verdade; grava o registro. */
    async callAlignment(input = {}) {
      return run('callAlignment', 'alinhamento.chamar', async ({ staff, can }) => {
        const a = {
          membro_id: String(input.membro_id ?? '').trim(), mensagem: String(input.mensagem ?? '').trim(), prazo: String(input.prazo ?? ''),
          canal_id: String(input.canal_id ?? '').trim(), link_call: String(input.link_call ?? '').trim(), reuniao_em: String(input.reuniao_em ?? '').trim(),
        };
        const check = validateAlignment(a, { selfId: staff.discord_id });
        if (!check.valid) return validationError(check.errors);
        const member = state.staff.find((s) => s.discord_id === a.membro_id);
        if (!member?.active) return validationError({ membro_id: ALIGNMENT_ERRORS.notStaff });
        let meetingId = null;
        if (a.reuniao_em) {
          if (!can('agenda.gerenciar')) return validationError({ reuniao_em: ALIGNMENT_ERRORS.noAgenda });
          const created = await adapter.saveMeeting(alignmentMeetingInput({
            membroId: a.membro_id, membroNome: member.display_name, selfId: staff.discord_id, mensagem: a.mensagem, reuniaoEm: a.reuniao_em, linkCall: a.link_call,
          }));
          if (created.error) {
            const errs = created.error.details?.errors;
            return errs ? validationError({ reuniao_em: errs.starts_at ?? errs._ ?? Object.values(errs)[0] }) : created;
          }
          meetingId = created.data.id;
        }
        const at = nowIso();
        const row = {
          id: uuid(), membro_id: a.membro_id, membro_nome: member.display_name, mensagem: a.mensagem, prazo: a.prazo,
          prazo_em: alignmentDeadlineAt(a.prazo, new Date(at)), canal_id: a.canal_id || null, link_call: a.link_call || null, reuniao_id: meetingId,
          dm_status: 'ok', dm_erro: null, canal_status: a.canal_id ? 'ok' : null, canal_erro: null, chamado_por: staff.discord_id, criado_em: at,
        };
        (state.alignments ??= []).push(row);
        save();
        return ok({
          id: row.id, sent_at: at, prazo_em: row.prazo_em, reuniao_id: meetingId,
          dm: { status: 'ok', erro: null }, canal: a.canal_id ? { status: 'ok', erro: null } : null, registrado: true,
        });
      });
    },

    async cancelAlignment(id, reason) {
      return run('cancelAlignment', 'alinhamentos.apagar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const row = (state.alignments ?? []).find((x) => x.id === id);
        if (!row) return fail('NOT_FOUND', APAGAR_ERRORS.alignment);
        if (row.cancelado_em) return validationError({ _: APAGAR_ERRORS.alignmentCancelled });
        const meeting = row.reuniao_id ? state.meetings.find((m) => m.id === row.reuniao_id) : null;
        if (['em_andamento', 'concluida'].includes(meeting?.status)) return validationError({ _: APAGAR_ERRORS.alignmentHappened });
        Object.assign(row, { cancelado_em: nowIso(), cancelado_por: staff.discord_id, cancelado_motivo: r.reason });
        auditApagar(staff, 'alinhamento', id, 'cancelado', {
          membro_id: row.membro_id, membro_nome: row.membro_nome, mensagem: row.mensagem, prazo: row.prazo, prazo_em: row.prazo_em,
          reuniao_id: row.reuniao_id, chamado_por: row.chamado_por, criado_em: row.criado_em,
        }, r.reason);
        save();
        return ok(null);
      });
    },

    async listAlignments({ limit = 20, offset = 0 } = {}) {
      return run('listAlignments', 'alinhamento.chamar', async () => {
        const all = [...(state.alignments ?? [])].sort((a, b) => b.criado_em.localeCompare(a.criado_em));
        const size = Math.max(1, Math.min(Number(limit) || 20, 100));
        const from = Math.max(0, Number(offset) || 0);
        return ok({
          items: all.slice(from, from + size).map((x) => ({ ...clone(x), membro_nome: nameOf(x.membro_id) ?? x.membro_nome, chamado_por_nome: nameOf(x.chamado_por) })),
          total: all.length,
        });
      });
    },

    /* ----- Botões da Agenda: status e avisos no Discord (simulados; o de verdade é a Edge Function) ----- */
    async startMeeting(id) {
      return run('startMeeting', 'agenda.gerenciar', async ({ staff }) => {
        const moved = moveMeeting(id, 'agendada', 'em_andamento', MEETING_STATUS_ERRORS.notStarted, staff);
        if (moved.error) return moved;
        const recipients = meetingRecipients(meetingList(moved.data), state.staff);
        return ok({ meeting: presentMeeting(moved.data), dm: { sent: recipients.length, failed: [] }, dm_error: null });
      });
    },

    async endMeeting(id) {
      return run('endMeeting', 'agenda.gerenciar', async ({ staff }) => {
        const moved = moveMeeting(id, 'em_andamento', 'concluida', MEETING_STATUS_ERRORS.notRunning, staff);
        return moved.error ? moved : ok(presentMeeting(moved.data));
      });
    },

    async announceMeeting(id, { webhookId } = {}) {
      return run('announceMeeting', 'agenda.gerenciar', async () => {
        const m = state.meetings.find((x) => x.id === id);
        if (!m) return fail('NOT_FOUND', DISCORD_SEND_ERRORS.meetingNotFound);
        if (m.status === 'concluida') return validationError({ _: DISCORD_SEND_ERRORS.meetingClosed });
        // Sem webhook escolhido: o primeiro ativo de Avisos (como a Edge Function).
        const w = webhookId ? state.webhooks.find((x) => x.id === webhookId) : state.webhooks.find((x) => x.active && x.purpose === 'avisos');
        if (!w) return validationError({ _: DISCORD_SEND_ERRORS.noWebhook });
        if (!w.active || w.purpose !== 'avisos') return validationError({ _: DISCORD_SEND_ERRORS.webhook });
        return ok({ sent_at: nowIso(), discord_status: sentStatus(w.name) });
      });
    },

    async notifyMeeting(id) {
      return run('notifyMeeting', 'agenda.gerenciar', async () => {
        const m = state.meetings.find((x) => x.id === id);
        if (!m) return fail('NOT_FOUND', DISCORD_SEND_ERRORS.meetingNotFound);
        if (m.status === 'concluida') return validationError({ _: DISCORD_SEND_ERRORS.meetingClosed });
        const recipients = meetingRecipients(meetingList(m), state.staff);
        if (!recipients.length) return validationError({ _: DISCORD_SEND_ERRORS.noRecipients });
        return ok({ sent_at: nowIso(), dm: { sent: recipients.length, failed: [] } });
      });
    },

    /* ----- Etapa 10: produtividade ----- */
    async getProductivity({ from, to } = {}) {
      return run('getProductivity', 'produtividade.ver', async () => {
        if (!from || !to || !(Date.parse(to) > Date.parse(from)) || Date.parse(to) - Date.parse(from) > 400 * 864e5) {
          return validationError({ _: PRODUCTIVITY_ERRORS.period });
        }
        return ok(aggregateProductivity({
          evaluations: state.alEvaluations, participants: state.alParticipants, staff: state.staff,
          from: new Date(from).toISOString(), to: new Date(to).toISOString(),
        }));
      });
    },

    /* ----- Entrevistas: escala, agenda e registro (24_escalas.sql; regras em js/core/escalas.js) ----- */
    async getEscalaConfig() {
      return run('getEscalaConfig', 'staff', async ({ can }) => {
        if (!escCanRead(can)) return fail('FORBIDDEN');
        return ok(clone(state.escCfg));
      });
    },

    async saveEscalaConfig(input = {}) {
      return run('saveEscalaConfig', 'escalas.gerenciar', async ({ staff }) => {
        const next = { ...state.escCfg, ...pickEscalaConfig(input) };
        const { valid, errors } = validateEscalaConfig(next);
        if (!valid) return validationError(errors);
        const diff = escConfigDiff(state.escCfg, next);
        state.escCfg = { ...next, atualizado_por: staff.discord_id, atualizado_em: nowIso() };
        if (diff) auditApagar(staff, 'configuracao_entrevistas', '1', 'alterada', diff.before, null, { novo: diff.after });
        save();
        return ok(clone(state.escCfg));
      });
    },

    async resetEscalaConfig(reason) {
      return run('resetEscalaConfig', 'escalas.redefinir', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        // Canais e cargos do Discord ficam como estão; o resto volta ao padrão (redefinir_configuracao_entrevistas, SQL 25).
        const { dias_semana, horarios, antecedencia_aviso_minutos, mensagem_link_call, mensagem_cargo_id } = DEFAULT_ESCALA_CONFIG;
        const next = { ...state.escCfg, dias_semana: [...dias_semana], horarios: [...horarios], antecedencia_aviso_minutos, mensagem_link_call, mensagem_cargo_id };
        const diff = escConfigDiff(state.escCfg, next);
        state.escCfg = { ...next, atualizado_por: staff.discord_id, atualizado_em: nowIso() };
        if (diff) auditApagar(staff, 'configuracao_entrevistas', '1', 'redefinida', diff.before, r.reason, { novo: diff.after });
        save();
        return ok(clone(state.escCfg));
      });
    },

    async getEscala(id) {
      return run('getEscala', 'staff', async ({ staff, can }) => {
        if (!escCanRead(can)) return fail('FORBIDDEN');
        const escala = id ? state.escalas.find((e) => e.id === id) : state.escalas.find((e) => e.status !== 'encerrada');
        if (id && !escala) return fail('NOT_FOUND', ESCALA_ERRORS.noEscala);
        if (!escala) return ok({ escala: null, slots: [], minha_disponibilidade: [], respondi: false });
        return ok({
          escala: clone(escala),
          slots: state.escSlots.filter((s) => s.escala_id === escala.id).map(escPresentSlot),
          minha_disponibilidade: state.escDisp.filter((d) => d.escala_id === escala.id && d.discord_id === staff.discord_id).map(({ dia_semana, horario }) => ({ dia_semana, horario })),
          respondi: state.escResp.some((r) => r.escala_id === escala.id && r.discord_id === staff.discord_id),
        });
      });
    },

    async listEscalas() {
      return run('listEscalas', 'escalas.gerenciar', async () => ok(
        [...state.escalas].sort((a, b) => b.periodo_inicio.localeCompare(a.periodo_inicio)).map((e) => ({
          ...clone(e), slots_total: state.escSlots.filter((s) => s.escala_id === e.id).length,
          sessoes_total: state.escSessoes.filter((s) => s.escala_id === e.id).length,
        }))));
    },

    async openEscala(input = {}) {
      return run('openEscala', 'escalas.gerenciar', async ({ staff }) => {
        const { valid, errors } = validateOpenEscala(input, now());
        if (!valid) return validationError(errors);
        if (state.escalas.some((e) => e.status !== 'encerrada')) return validationError({ _: ESCALA_ERRORS.active });
        const e = {
          id: uuid(), periodo_inicio: input.periodo_inicio, periodo_fim: input.periodo_fim, status: 'aberta_disponibilidade',
          abertura_disponibilidade_em: nowIso(), encerramento_disponibilidade_em: new Date(input.encerramento).toISOString(),
          criado_por: staff.discord_id, criado_em: nowIso(), publicado_por: null, publicado_em: null, discord_message_id: null, discord_status: null,
        };
        state.escalas.push(e);
        escLog('escala_aberta', e.id, staff.discord_id, null, { periodo_inicio: e.periodo_inicio, periodo_fim: e.periodo_fim });
        save();
        return ok(clone(e));
      });
    },

    async getAvailabilitySummary(escalaId) {
      return run('getAvailabilitySummary', 'escalas.gerenciar', async () => {
        const e = state.escalas.find((x) => x.id === escalaId);
        if (!e) return fail('NOT_FOUND', ESCALA_ERRORS.noEscala);
        const membros = state.staff.filter((s) => s.active && escEligible(s.discord_id)).map((s) => ({
          discord_id: s.discord_id, display_name: s.display_name, role: s.role, respondeu: state.escResp.some((r) => r.escala_id === e.id && r.discord_id === s.discord_id),
        })).sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'));
        const cells = new Map();
        for (const d of state.escDisp.filter((x) => x.escala_id === e.id)) {
          const k = cellKey(d.dia_semana, d.horario);
          if (!cells.has(k)) cells.set(k, { dia_semana: d.dia_semana, horario: d.horario, discord_ids: [] });
          cells.get(k).discord_ids.push(d.discord_id);
        }
        return ok({ membros, celulas: [...cells.values()].map((c) => ({ ...c, discord_ids: c.discord_ids.sort() })) });
      });
    },

    async saveMyAvailability(escalaId, slots = []) {
      return run('saveMyAvailability', 'staff', async ({ staff, can }) => {
        if (!escEligible(staff.discord_id)) return fail('FORBIDDEN');
        const e = state.escalas.find((x) => x.id === escalaId);
        if (!e || e.status !== 'aberta_disponibilidade') return validationError({ _: ESCALA_ERRORS.notOpen });
        if (now().getTime() > Date.parse(e.encerramento_disponibilidade_em)) return validationError({ _: ESCALA_ERRORS.closed });
        const { valid, errors } = validateAvailability(slots, state.escCfg);
        if (!valid) return validationError(errors);
        state.escDisp = state.escDisp.filter((d) => !(d.escala_id === e.id && d.discord_id === staff.discord_id));
        const seen = new Set();
        for (const s of slots) {
          const k = cellKey(s.dia_semana, s.horario);
          if (seen.has(k)) continue;
          seen.add(k);
          state.escDisp.push({ id: uuid(), escala_id: e.id, discord_id: staff.discord_id, dia_semana: s.dia_semana, horario: s.horario, criado_em: nowIso() });
        }
        state.escResp = state.escResp.filter((r) => !(r.escala_id === e.id && r.discord_id === staff.discord_id));
        state.escResp.push({ escala_id: e.id, discord_id: staff.discord_id, respondeu_em: nowIso() });
        save();
        return ok({ total: seen.size });
      });
    },

    async closeAvailability(escalaId) {
      return run('closeAvailability', 'escalas.gerenciar', async ({ staff }) => {
        const e = state.escalas.find((x) => x.id === escalaId);
        if (!e || e.status !== 'aberta_disponibilidade') return validationError({ _: ESCALA_ERRORS.notOpen });
        e.status = 'analise';
        escLog('disponibilidade_encerrada', e.id, staff.discord_id, { status: 'aberta_disponibilidade' }, { status: 'analise' });
        save();
        return ok(clone(e));
      });
    },

    async saveEscalaSlots(escalaId, slots = []) {
      return run('saveEscalaSlots', 'escalas.gerenciar', async () => {
        const e = state.escalas.find((x) => x.id === escalaId);
        if (!e || e.status !== 'analise') return validationError({ _: ESCALA_ERRORS.notAnalysis });
        const { valid, errors } = validateSlots(slots);
        if (!valid) return validationError(errors);
        if (slots.some((s) => !escEligible(s.discord_id))) return validationError({ _: ESCALA_ERRORS.notEligible });
        state.escSlots = state.escSlots.filter((s) => s.escala_id !== e.id);
        const seen = new Set();
        for (const s of slots) {
          const k = `${cellKey(s.dia_semana, s.horario)}|${s.discord_id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          state.escSlots.push({ id: uuid(), escala_id: e.id, dia_semana: s.dia_semana, horario: s.horario, discord_id: s.discord_id, funcao: s.funcao, realocado_por: null, realocado_em: null });
        }
        save();
        return ok({ total: seen.size });
      });
    },

    async publishEscala(escalaId) {
      return run('publishEscala', 'escalas.gerenciar', async ({ staff }) => {
        const e = state.escalas.find((x) => x.id === escalaId);
        if (!e || e.status !== 'analise') return validationError({ _: ESCALA_ERRORS.notAnalysis });
        const slots = state.escSlots.filter((s) => s.escala_id === e.id);
        if (!slots.length) return validationError({ _: ESCALA_ERRORS.empty });
        Object.assign(e, { status: 'publicada', publicado_por: staff.discord_id, publicado_em: nowIso() });
        let created = 0;
        const dias = [...new Set(slots.map((s) => s.dia_semana))];
        for (const data of datesInPeriod(e.periodo_inicio, e.periodo_fim, dias)) {
          for (const horario of [...new Set(slots.filter((s) => s.dia_semana === weekdayOf(data)).map((s) => s.horario))]) {
            if (sessionStart(data, horario).getTime() < now().getTime()) continue;
            let ses = state.escSessoes.find((x) => x.data_entrevista === data && x.horario === horario);
            if (!ses) {
              ses = { id: uuid(), escala_id: e.id, data_entrevista: data, horario, status: 'agendada', aviso_enviado: false, aviso_enviado_em: null, aviso_erro: null };
              state.escSessoes.push(ses);
              created++;
            }
            if (ses.escala_id !== e.id) continue;
            for (const s of slots.filter((x) => x.dia_semana === weekdayOf(data) && x.horario === horario)) {
              if (!state.escPart.some((p) => p.sessao_id === ses.id && p.discord_id === s.discord_id)) {
                state.escPart.push({ id: uuid(), sessao_id: ses.id, discord_id: s.discord_id, funcao: s.funcao, substituindo_id: null, presente: true, adicionado_por: staff.discord_id, adicionado_em: nowIso() });
              }
            }
          }
        }
        e.discord_status = state.escCfg.canal_discord_escala ? 'enviado em 1 mensagem(ns)' : null;
        escLog('escala_publicada', e.id, staff.discord_id, { status: 'analise' }, { status: 'publicada', sessoes_criadas: created });
        save();
        return ok({ escala: clone(e), sessoes: created, discord_error: state.escCfg.canal_discord_escala ? null : ESC_DISCORD_ERRORS.noChannel });
      });
    },

    async sendEscalaToDiscord(escalaId) {
      return run('sendEscalaToDiscord', 'escalas.gerenciar', async () => {
        const e = state.escalas.find((x) => x.id === escalaId);
        if (!e) return fail('NOT_FOUND', ESC_DISCORD_ERRORS.notFound);
        if (e.status !== 'publicada') return validationError({ _: ESC_DISCORD_ERRORS.notPublished });
        if (!state.escCfg.canal_discord_escala) return validationError({ _: ESC_DISCORD_ERRORS.noChannel });
        Object.assign(e, { discord_message_id: `mock-${e.id}`, discord_status: 'enviado em 1 mensagem(ns)' });
        save();
        return ok({ discord_status: e.discord_status, discord_message_id: e.discord_message_id });
      });
    },

    async endEscala(escalaId, reason) {
      return run('endEscala', 'escalas.cancelar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const e = state.escalas.find((x) => x.id === escalaId);
        if (!e) return fail('NOT_FOUND', APAGAR_ERRORS.escala);
        if (e.status === 'encerrada') return validationError({ _: APAGAR_ERRORS.escalaClosed });
        const before = e.status;
        const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
        const antes = {
          periodo_inicio: e.periodo_inicio, periodo_fim: e.periodo_fim, status: before, publicado_em: e.publicado_em ?? null,
          horarios: state.escSlots.filter((x) => x.escala_id === e.id).map(({ dia_semana, horario, discord_id, funcao }) => ({ dia_semana, horario, discord_id, funcao }))
            .sort((a, b) => a.dia_semana - b.dia_semana || a.horario.localeCompare(b.horario) || a.discord_id.localeCompare(b.discord_id)),
          sessoes_futuras: state.escSessoes.filter((x) => x.escala_id === e.id && x.status === 'agendada' && x.data_entrevista >= today).length,
        };
        e.status = 'encerrada';
        escLog('escala_encerrada', e.id, staff.discord_id, { status: before }, { status: 'encerrada', motivo: r.reason });
        auditApagar(staff, 'escala', e.id, 'fechada', antes, r.reason);
        save();
        return ok(null);
      });
    },

    /** Cancela a sessão e "avisa" os outros escalados (no banco de verdade, a função do Discord manda o privado). */
    async cancelInterviewSession(id, reason) {
      return run('cancelInterviewSession', 'escalas.cancelar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const s = state.escSessoes.find((x) => x.id === id);
        if (!s) return fail('NOT_FOUND', APAGAR_ERRORS.session);
        if (['concluida', 'cancelada'].includes(s.status)) return validationError({ _: APAGAR_ERRORS.sessionClosed });
        const people = state.escPart.filter((p) => p.sessao_id === id && p.presente);
        const before = s.status;
        s.status = 'cancelada';
        escLog('sessao_cancelada', s.id, staff.discord_id, { status: before }, { status: 'cancelada', motivo: r.reason });
        auditApagar(staff, 'sessao_entrevista', s.id, 'cancelada', {
          data_entrevista: s.data_entrevista, horario: s.horario, status: before, escala_id: s.escala_id ?? null,
          participantes: people.map((p) => ({ discord_id: p.discord_id, funcao: p.funcao })),
        }, r.reason);
        save();
        const others = people.filter((p) => p.discord_id !== staff.discord_id);
        return ok({ session: escPresentSession(s), dm: others.length ? { sent: others.length, failed: [] } : null, discord_error: null });
      });
    },

    /** Apaga as sessões agendadas que ainda não começaram e não têm registro; opcionalmente encerra a escala publicada (limpar_agenda, SQL 26). */
    async clearInterviewAgenda({ reason, closeEscala = true } = {}) {
      return run('clearInterviewAgenda', 'escalas.cancelar', async ({ staff }) => {
        const r = reasonOf(reason);
        if (r.error) return r.error;
        const doomed = state.escSessoes
          .filter((s) => s.status === 'agendada' && sessionStart(s.data_entrevista, s.horario).getTime() >= now().getTime() && !state.escRegs.some((x) => x.sessao_id === s.id))
          .sort((a, b) => a.data_entrevista.localeCompare(b.data_entrevista) || a.horario.localeCompare(b.horario));
        const published = closeEscala !== false ? state.escalas.filter((e) => e.status === 'publicada') : [];
        if (!doomed.length && !published.length) return validationError({ _: APAGAR_ERRORS.agendaEmpty });
        const lista = doomed.map((s) => ({
          data_entrevista: s.data_entrevista, horario: s.horario, escala_id: s.escala_id ?? null,
          participantes: state.escPart.filter((p) => p.sessao_id === s.id).map((p) => ({ discord_id: p.discord_id, funcao: p.funcao })),
        }));
        const fechadas = [];
        for (const e of published) {
          e.status = 'encerrada';
          fechadas.push({ id: e.id, periodo_inicio: e.periodo_inicio, periodo_fim: e.periodo_fim });
          escLog('escala_encerrada', e.id, staff.discord_id, { status: 'publicada' }, { status: 'encerrada', motivo: r.reason, origem: 'agenda_limpa' });
        }
        const ids = new Set(doomed.map((s) => s.id));
        state.escSessoes = state.escSessoes.filter((s) => !ids.has(s.id));
        state.escPart = state.escPart.filter((p) => !ids.has(p.sessao_id));
        escLog('agenda_limpa', null, staff.discord_id, { sessoes: lista.length }, { sessoes_apagadas: lista.length, escalas_encerradas: fechadas.length, motivo: r.reason });
        auditApagar(staff, 'agenda_entrevistas', 'todas', 'limpa', { sessoes: lista, escalas_encerradas: fechadas }, r.reason,
          { sessoes_apagadas: lista.length, escalas_encerradas: fechadas.length });
        save();
        return ok({ sessoes_apagadas: lista.length, escalas_encerradas: fechadas.length });
      });
    },

    async reallocateSlot(slotId, novoId) {
      return run('reallocateSlot', 'escalas.gerenciar', async ({ staff }) => {
        const s = state.escSlots.find((x) => x.id === slotId);
        if (!s) return fail('NOT_FOUND', ESCALA_ERRORS.noSlot);
        if (state.escalas.find((e) => e.id === s.escala_id)?.status !== 'publicada') return validationError({ _: ESCALA_ERRORS.notPublished });
        if (!escEligible(novoId)) return validationError({ _: ESCALA_ERRORS.notEligible });
        if (state.escSlots.some((x) => x.escala_id === s.escala_id && x.dia_semana === s.dia_semana && x.horario === s.horario && x.discord_id === novoId)) {
          return validationError({ _: ESCALA_ERRORS.alreadyThere });
        }
        const before = { discord_id: s.discord_id, dia_semana: s.dia_semana, horario: s.horario, funcao: s.funcao };
        for (const ses of state.escSessoes) {
          if (ses.escala_id !== s.escala_id || ses.horario !== s.horario || weekdayOf(ses.data_entrevista) !== s.dia_semana || ses.status !== 'agendada') continue;
          if (sessionStart(ses.data_entrevista, ses.horario).getTime() <= now().getTime() || state.escRegs.some((r) => r.sessao_id === ses.id)) continue;
          const p = state.escPart.find((x) => x.sessao_id === ses.id && x.discord_id === s.discord_id);
          if (p && !state.escPart.some((x) => x.sessao_id === ses.id && x.discord_id === novoId)) {
            Object.assign(p, { discord_id: novoId, substituindo_id: s.discord_id, adicionado_por: staff.discord_id, adicionado_em: nowIso() });
          }
        }
        Object.assign(s, { discord_id: novoId, realocado_por: staff.discord_id, realocado_em: nowIso() });
        escLog('slot_realocado', s.id, staff.discord_id, before, { discord_id: novoId });
        save();
        return ok(null);
      });
    },

    async listInterviewSessions({ from, to } = {}) {
      return run('listInterviewSessions', 'staff', async ({ can }) => {
        if (!escCanRead(can)) return fail('FORBIDDEN');
        return ok(state.escSessoes.filter((s) => (!from || s.data_entrevista >= from) && (!to || s.data_entrevista <= to))
          .sort((a, b) => a.data_entrevista.localeCompare(b.data_entrevista) || escTimeKey(a.horario).localeCompare(escTimeKey(b.horario)))
          .map(escPresentSession));
      });
    },

    async getInterviewSession(id) {
      return run('getInterviewSession', 'staff', async ({ staff, can }) => {
        if (!escCanRead(can)) return fail('FORBIDDEN');
        const s = state.escSessoes.find((x) => x.id === id);
        if (!s) return fail('NOT_FOUND', ESCALA_ERRORS.noSession);
        const seesHistory = can('escalas.gerenciar') || escIsParticipant(s.id, staff.discord_id);
        const reg = state.escRegs.find((r) => r.sessao_id === s.id) ?? null;
        return ok({
          ...escPresentSession(s),
          registro: reg ? { ...clone(reg), registrado_por_nome: nameOf(reg.registrado_por) } : null,
          historico: seesHistory
            ? state.escHist.filter((h) => h.referencia_id === s.id).map((h) => ({ ...clone(h), autor_nome: nameOf(h.discord_id) })).reverse()
            : [],
        });
      });
    },

    async setInterviewSessionStatus(id, status) {
      return run('setInterviewSessionStatus', 'staff', async ({ staff, can }) => {
        const s = state.escSessoes.find((x) => x.id === id);
        if (!s) return fail('NOT_FOUND', ESCALA_ERRORS.noSession);
        if (status === 'em_andamento') {
          if (!(can('escalas.gerenciar') || escIsParticipant(id, staff.discord_id))) return validationError({ _: ESCALA_ERRORS.notParticipant });
          if (s.status !== 'agendada') return validationError({ _: ESCALA_ERRORS.startOnly });
        } else if (status === 'cancelada') {
          if (!can('escalas.gerenciar')) return fail('FORBIDDEN');
          if (['concluida', 'cancelada'].includes(s.status)) return validationError({ _: ESCALA_ERRORS.alreadyClosed });
        } else return validationError({ _: ESCALA_ERRORS.badStatus });
        const before = s.status;
        s.status = status;
        escLog(`sessao_${status}`, s.id, staff.discord_id, { status: before }, { status });
        save();
        return ok(escPresentSession(s));
      });
    },

    async registerSubstitution(sessaoId, input = {}) {
      return run('registerSubstitution', 'staff', async ({ staff, can }) => {
        const s = state.escSessoes.find((x) => x.id === sessaoId);
        if (!s) return fail('NOT_FOUND', ESCALA_ERRORS.noSession);
        if (!(can('escalas.gerenciar') || escIsParticipant(sessaoId, staff.discord_id))) return validationError({ _: ESCALA_ERRORS.notParticipant });
        if (state.escRegs.some((r) => r.sessao_id === sessaoId) && !can('escalas.gerenciar')) return validationError({ _: ESCALA_ERRORS.registeredLocked });
        const { valid, errors } = validateSubstitution(input);
        if (!valid) return validationError(errors);
        const orig = state.escPart.find((p) => p.sessao_id === sessaoId && p.discord_id === input.original && p.presente);
        if (!orig) return validationError({ _: ESCALA_ERRORS.leaving });
        if (!escEligible(input.substituto)) return validationError({ _: ESCALA_ERRORS.notEligible });
        const motivo = String(input.motivo ?? '').trim() || null;
        orig.presente = false;
        const existing = state.escPart.find((p) => p.sessao_id === sessaoId && p.discord_id === input.substituto);
        if (existing) Object.assign(existing, { presente: true, funcao: orig.funcao, substituindo_id: input.original });
        else state.escPart.push({ id: uuid(), sessao_id: sessaoId, discord_id: input.substituto, funcao: orig.funcao, substituindo_id: input.original, presente: true, adicionado_por: staff.discord_id, adicionado_em: nowIso() });
        escLog('substituicao_registrada', sessaoId, staff.discord_id, { discord_id: input.original, funcao: orig.funcao }, { discord_id: input.substituto, motivo });
        save();
        return ok(escPresentSession(s));
      });
    },

    async registerAbsence(sessaoId, discordId) {
      return run('registerAbsence', 'staff', async ({ staff, can }) => {
        const s = state.escSessoes.find((x) => x.id === sessaoId);
        if (!s) return fail('NOT_FOUND', ESCALA_ERRORS.noSession);
        if (!(can('escalas.gerenciar') || escIsParticipant(sessaoId, staff.discord_id))) return validationError({ _: ESCALA_ERRORS.notParticipant });
        if (state.escRegs.some((r) => r.sessao_id === sessaoId) && !can('escalas.gerenciar')) return validationError({ _: ESCALA_ERRORS.registeredLocked });
        const p = state.escPart.find((x) => x.sessao_id === sessaoId && x.discord_id === discordId && x.presente);
        if (!p) return validationError({ _: ESCALA_ERRORS.absent });
        p.presente = false;
        escLog('ausencia_registrada', sessaoId, staff.discord_id, { discord_id: discordId, presente: true }, { discord_id: discordId, presente: false });
        save();
        return ok(escPresentSession(s));
      });
    },

    async registerInterview(sessaoId, input = {}) {
      return run('registerInterview', 'staff', async ({ staff, can }) => {
        const s = state.escSessoes.find((x) => x.id === sessaoId && x.status !== 'cancelada');
        if (!s) return fail('NOT_FOUND', ESCALA_ERRORS.noSession);
        if (!(can('escalas.gerenciar') || escIsParticipant(sessaoId, staff.discord_id))) return validationError({ _: ESCALA_ERRORS.notParticipant });
        if (state.escRegs.some((r) => r.sessao_id === sessaoId)) return validationError({ _: ESCALA_ERRORS.registered });
        const print = input.print ?? null;
        const { valid, errors } = validateRegistro({ ...input, tem_print: Boolean(print) });
        if (!valid) return validationError(errors);
        const file = validatePrintFile(print);
        if (!file.valid) return validationError({ print: file.error });
        if ((input.participantes ?? []).some((p) => !escEligible(p.discord_id))) return validationError({ _: ESCALA_ERRORS.notEligible });
        for (const p of input.participantes ?? []) {
          const row = state.escPart.find((x) => x.sessao_id === sessaoId && x.discord_id === p.discord_id);
          const fields = { funcao: p.funcao, presente: p.presente !== false, substituindo_id: p.substituindo_id || null };
          if (row) Object.assign(row, fields);
          else state.escPart.push({ id: uuid(), sessao_id: sessaoId, discord_id: p.discord_id, ...fields, adicionado_por: staff.discord_id, adicionado_em: nowIso() });
        }
        const path = `${sessaoId}/${uuid()}.${(print.type || 'image/png').split('/')[1].replace('jpeg', 'jpg')}`;
        printFiles.set(path, print);
        const reg = {
          id: uuid(), sessao_id: sessaoId, total_entrevistados: Number(input.total_entrevistados), observacoes: String(input.observacoes ?? '').trim() || null,
          print_call_path: path, registrado_por: staff.discord_id, registrado_em: nowIso(), discord_message_id: null, discord_status: null, editado_por: null, editado_em: null,
        };
        state.escRegs.push(reg);
        s.status = 'concluida';
        escLog('registro_criado', sessaoId, staff.discord_id, null, { total_entrevistados: reg.total_entrevistados, registro_id: reg.id });
        const sent = state.escCfg.canal_discord_registros;
        if (sent) Object.assign(reg, { discord_message_id: `mock-${reg.id}`, discord_status: `enviado em ${nowIso()}` });
        save();
        return ok({ registro: clone(reg), discord_error: sent ? null : ESC_DISCORD_ERRORS.noChannel });
      });
    },

    async editInterviewRegistro(sessaoId, input = {}) {
      return run('editInterviewRegistro', 'staff', async ({ staff, can }) => {
        if (!can('escalas.gerenciar')) return validationError({ _: ESCALA_ERRORS.notDirection });
        const reg = state.escRegs.find((r) => r.sessao_id === sessaoId);
        if (!reg) return fail('NOT_FOUND', ESCALA_ERRORS.noRegistro);
        const { valid, errors } = validateRegistroEdit(input);
        if (!valid) return validationError(errors);
        if (input.print) {
          const file = validatePrintFile(input.print);
          if (!file.valid) return validationError({ print: file.error });
        }
        const before = { total_entrevistados: reg.total_entrevistados, observacoes: reg.observacoes };
        Object.assign(reg, { total_entrevistados: Number(input.total_entrevistados), observacoes: String(input.observacoes ?? '').trim() || null, editado_por: staff.discord_id, editado_em: nowIso() });
        if (input.print) {
          reg.print_call_path = `${sessaoId}/${uuid()}.${(input.print.type || 'image/png').split('/')[1].replace('jpeg', 'jpg')}`;
          printFiles.set(reg.print_call_path, input.print);
        }
        escLog('registro_editado', sessaoId, staff.discord_id, before, { total_entrevistados: reg.total_entrevistados, observacoes: reg.observacoes });
        save();
        return ok(clone(reg));
      });
    },

    async getInterviewPrintUrl(sessaoId) {
      return run('getInterviewPrintUrl', 'staff', async ({ can }) => {
        if (!escCanRead(can)) return fail('FORBIDDEN');
        const reg = state.escRegs.find((r) => r.sessao_id === sessaoId);
        if (!reg) return fail('NOT_FOUND', ESCALA_ERRORS.noRegistro);
        return ok(printFiles.has(reg.print_call_path) ? `mock-print://${reg.print_call_path}` : null);
      });
    },

    async sendInterviewRegistro(sessaoId, { resend = false } = {}) {
      return run('sendInterviewRegistro', 'staff', async ({ can }) => {
        if (!escCanRead(can)) return fail('FORBIDDEN');
        const reg = state.escRegs.find((r) => r.sessao_id === sessaoId);
        if (!reg) return fail('NOT_FOUND', ESC_DISCORD_ERRORS.noRegistro);
        if (reg.discord_message_id && !(resend && can('escalas.gerenciar'))) return validationError({ _: DISCORD_SEND_ERRORS.alreadySent });
        if (!state.escCfg.canal_discord_registros) return validationError({ _: ESC_DISCORD_ERRORS.noChannel });
        Object.assign(reg, { discord_message_id: `mock-${reg.id}`, discord_status: `enviado em ${nowIso()}` });
        save();
        return ok({ discord_message_id: reg.discord_message_id, discord_status: reg.discord_status });
      });
    },

    async sendInterviewNotice(sessaoId) {
      return run('sendInterviewNotice', 'escalas.gerenciar', async ({ staff }) => {
        const s = state.escSessoes.find((x) => x.id === sessaoId);
        if (!s) return fail('NOT_FOUND', ESC_DISCORD_ERRORS.notFound);
        if (s.aviso_enviado) return ok({ id: s.id, status: 'ja_avisada' });
        if (!state.escCfg.canal_discord_avisos) return validationError({ _: ESC_DISCORD_ERRORS.noChannel });
        Object.assign(s, { aviso_enviado: true, aviso_enviado_em: nowIso(), aviso_erro: null });
        const people = state.escPart.filter((p) => p.sessao_id === s.id && p.presente);
        escLog('aviso_enviado', s.id, staff.discord_id, null, { canal: 'ok', dm: { sent: people.length, failed: [] } });
        save();
        return ok({ id: s.id, status: 'avisada', dm: { sent: people.length, failed: [] } });
      });
    },

    async listEscalaHistory({ limit = 100 } = {}) {
      return run('listEscalaHistory', 'escalas.gerenciar', async () => ok(
        [...state.escHist].reverse().slice(0, limit).map((h) => ({ ...clone(h), autor_nome: nameOf(h.discord_id) }))));
    },

    async listStaffNames() {
      return run('listStaffNames', 'staff', async () => ok(state.staff.map((s) => ({ discord_id: s.discord_id, display_name: s.display_name }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'))));
    },

    /* ----- Etapa 7: envio ao Discord (simulado; o de verdade é a Edge Function) ----- */
    async sendAlToDiscord(evaluationId, { webhookId, resend = false } = {}) {
      return run('sendAlToDiscord', 'allowlist.avaliar', async ({ staff, can }) => {
        const e = state.alEvaluations.find((x) => x.id === evaluationId);
        if (!e || !seesEval(e, staff, can)) return evalNotFound();
        if (e.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (e.sent_to_discord_at && !resend) return validationError({ _: DISCORD_SEND_ERRORS.alreadySent });
        const w = state.webhooks.find((x) => x.id === webhookId);
        if (!w || !w.active || w.purpose !== e.kind) return validationError({ _: DISCORD_SEND_ERRORS.webhook });
        Object.assign(e, { sent_to_discord_at: nowIso(), discord_status: sentStatus(w.name) });
        save();
        return ok({ sent_to_discord_at: e.sent_to_discord_at, discord_status: e.discord_status });
      });
    },

    async sendAnnouncementToDiscord(announcementId, { webhookId, channel = true, dm = false } = {}) {
      return run('sendAnnouncementToDiscord', 'avisos.enviar', async () => {
        if (!channel && !dm) return validationError({ _: DISCORD_SEND_ERRORS.nothingToSend });
        const a = state.announcements.find((x) => x.id === announcementId);
        if (!a) return fail('NOT_FOUND', DISCORD_SEND_ERRORS.announcementNotFound);
        const w = state.webhooks.find((x) => x.id === webhookId);
        if (channel && (!w || !w.active || w.purpose !== 'avisos')) return validationError({ _: DISCORD_SEND_ERRORS.webhook });
        // Simulado: todos recebem no privado (o de verdade é a Edge Function com o bot).
        const recipients = announcementRecipients(a.audience_roles, state.staff);
        return ok({ sent_at: nowIso(), discord_status: channel ? sentStatus(w.name) : '', dm: dm ? { sent: recipients.length, failed: [] } : null });
      });
    },

    async listDiscordRoleIds() {
      return run('listDiscordRoleIds', 'staff', async ({ can }) => (can('webhooks.gerenciar') || can('avisos.enviar')
        ? ok((state.discordRoleIds ?? []).map((r) => ({ role: r.role, discord_role_id: r.discord_role_id })))
        : fail('FORBIDDEN')));
    },

    async saveDiscordRoleIds(map = {}) {
      return run('saveDiscordRoleIds', 'webhooks.gerenciar', async ({ staff }) => {
        const { valid, errors } = validateDiscordRoleIds(map);
        if (!valid) return validationError(errors);
        const rows = new Map((state.discordRoleIds ?? []).map((r) => [r.role, r]));
        for (const [role, raw] of Object.entries(map)) {
          const id = String(raw ?? '').trim();
          const before = rows.get(role);
          if (!id) {
            if (before) { rows.delete(role); audit(staff, 'cargo_discord', role, 'removido', { discord_role_id: before.discord_role_id }, null); }
            continue;
          }
          if (before?.discord_role_id === id) continue;
          rows.set(role, { role, discord_role_id: id, updated_by: staff.discord_id, updated_at: nowIso() });
          audit(staff, 'cargo_discord', role, before ? 'alterado' : 'cadastrado', before ? { discord_role_id: before.discord_role_id } : null, { discord_role_id: id });
        }
        state.discordRoleIds = [...rows.values()];
        save();
        return ok(state.discordRoleIds.map((r) => ({ role: r.role, discord_role_id: r.discord_role_id })));
      });
    },

    async testDiscordWebhook(webhookId) {
      return run('testDiscordWebhook', 'webhooks.gerenciar', async () => (
        state.webhooks.some((w) => w.id === webhookId) ? ok(null) : fail('NOT_FOUND', 'Webhook não encontrado.')));
    },
  };

  /* ---------- Etapa 5: apoio da Allowlist ---------- */
  function usesAllowlist(can) {
    return can('allowlist.avaliar') || can('allowlist.historico') || can('lore.gerenciar');
  }
  function seesEval(e, staff, can) {
    return can('allowlist.historico') || e.created_by === staff.discord_id
      || state.alParticipants.some((p) => p.evaluation_id === e.id && p.discord_id === staff.discord_id);
  }
  function seesWebhook(w, can) {
    return can('webhooks.gerenciar')
      || (w.active && ((['allowlist', 'entrevista'].includes(w.purpose) && can('allowlist.avaliar')) || (w.purpose === 'avisos' && can('avisos.enviar'))));
  }
  function evalNotFound() { return fail('NOT_FOUND', 'Análise não encontrada.'); }
  function presentConfig(row) { return clone(row); }
  function presentEval(e) { return { ...clone(e), created_by_name: nameOf(e.created_by) }; }
  function presentAttachment(a) {
    const { evaluation_id, created_by, ...rest } = clone(a);
    return rest;
  }
  function presentWebhook(w) { return Object.fromEntries(WEBHOOK_COLUMNS.map((c) => [c, clone(w[c])])); }
  function detailOf(e) {
    return {
      ...presentEval(e),
      participants: state.alParticipants.filter((p) => p.evaluation_id === e.id)
        .map(({ discord_id, role }) => ({ discord_id, role, display_name: nameOf(discord_id) }))
        .sort((a, b) => (a.role === 'responsavel' ? -1 : b.role === 'responsavel' ? 1 : 0)),
      answers: state.alAnswers.filter((a) => a.evaluation_id === e.id).sort((a, b) => a.position - b.position)
        .map(({ evaluation_id, ...a }) => clone(a)),
      attachments: state.alAttachments.filter((a) => a.evaluation_id === e.id).sort((a, b) => a.position - b.position)
        .map(presentAttachment),
    };
  }

  /** Controles só do mock (não fazem parte do contrato). */
  const mock = {
    /** Troca o usuário simulado (null = deslogado) e avisa os ouvintes de sessão. */
    setUser(key) {
      if (key !== null && !MOCK_USERS[key]) throw new Error(`Usuário simulado desconhecido: ${key}`);
      sessionKey = key;
      save();
      notify();
    },
    /** Simula queda de rede: toda operação que precisa do servidor devolve NETWORK. */
    setOffline(value) { offline = Boolean(value); },
    /** Simula a Edge Function do Discord (Etapa 7): marca a análise como enviada. */
    markSent(evaluationId, status = 'enviado') {
      const e = state.alEvaluations.find((x) => x.id === evaluationId);
      if (!e) throw new Error(`Análise desconhecida: ${evaluationId}`);
      Object.assign(e, { sent_to_discord_at: nowIso(), discord_status: status });
      save();
    },
    /** Faz a PRÓXIMA chamada do método falhar com o código indicado (ex.: testar reversão otimista). */
    failNext(method, code = 'NETWORK') { pendingFailures.set(method, code); },
    /**
     * Executa `fn(adapter)` como outro usuário, sem avisar os ouvintes de sessão
     * (simula outra pessoa editando ao mesmo tempo).
     */
    async actAs(key, fn) {
      if (!MOCK_USERS[key]) throw new Error(`Usuário simulado desconhecido: ${key}`);
      const previous = sessionKey;
      sessionKey = key;
      try { return await fn(adapter); } finally { sessionKey = previous; }
    },
    /** Volta ao estado inicial com o seed indicado. */
    reset(newSeed = seed) {
      state = { ...initialState(newSeed, adminId, nowIso()), ...allowlistState(allowlistSeed, nowIso()) };
      printFiles.clear();
      photoFiles.clear();
      pendingFailures.clear();
      offline = false;
      save();
    },
    users: MOCK_USERS,
  };

  return Object.assign(adapter, { mock });
}
