// Implementação do contrato (js/data/adapter.js) sobre o Supabase.
// A segurança de verdade é a RLS do banco (supabase/03_rls.sql); as checagens aqui
// só dão respostas rápidas e mensagens claras, com os mesmos códigos do mock.
// As permissões de quem está logado vêm do banco (RPC current_staff_profile).
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';
import {
  EDITABLE_FIELDS, EXPORT_FORMAT, PROCEDURE_DEFAULTS, byStaffName, fail, ok, pickEditable, pickStaffMember,
  AL_DEFAULTS, WEBHOOK_COLUMNS, pickAlAnswers, pickAlEvaluation, pickAlParticipants, pickWebhook,
} from './adapter.js';
import {
  ALIGNMENT_ERRORS, ALLOWLIST_ERRORS, AREA_DISCORD_ERRORS, DISCORD_SEND_ERRORS, EVALUATION_REMINDER_ERRORS, EVALUATION_REMINDER_KINDS, MAX_PRINTS, validateDiscordRoleIds, printError, validateAlEvaluation, validateAlExtras,
  validateAlignment, validateAreaMessage, validateWebhook,
} from '../core/allowlist.js';
import { STATUSES, validateProcedure, validateStaffMember } from '../core/validate.js';
import {
  BLOCKED_NAME_FIELDS, CHECKLIST_FIELDS, LORE_ERRORS, QUESTION_FIELDS, photoError, pickCharacter, pickFields,
  validateBlockedName, validateCharacter, validateCharacterNote, validateChecklistItem, validateQuestion,
} from '../core/lore.js';
import { PRODUCTIVITY_ERRORS } from '../core/productivity.js';
import { APAGAR_ERRORS, validateReason } from '../core/apagar.js';
import { RULE_ERRORS, pickRule, validateRule } from '../core/rules.js';
import {
  AREA_DISCORD_ID, AREA_ERRORS, AREA_MANAGE_ERRORS, AREA_ROLES, DEFAULT_AREA_COLOR, DEFAULT_TAG_COLOR, areaProcedureAccess, areaSlug, historyRange,
  pickArea, pickAreaProcedure, pickAreaTag, validateArea, validateAreaProcedure, validateAreaTag,
} from '../core/areas.js';
import { PROFILE_ERRORS, pickProfileEdit, safeAvatar, validateProfileEdit } from '../core/perfil.js';
import {
  AREA_EVAL_ERRORS, DIRETORIA_ERRORS, SCORE_FIELDS, alignmentMeetingInput, pickDirectorEvaluation, promotionRulesError, reasonError,
  validateDirectorEvaluation, validateOccurrence,
} from '../core/diretoria.js';
import {
  ESCALA_ERRORS, ESC_DISCORD_ERRORS, DEFAULT_ESCALA_CONFIG, pickEscalaConfig, sessionView, validateAvailability, validateEscalaConfig,
  validateOpenEscala, validatePrintFile, validateRegistro, validateRegistroEdit, validateSlots, validateSubstitution,
} from '../core/escalas.js';
import { CONFLICT_PREFIX, MEETING_STATUS_ERRORS, participantLabel, pickMeeting, validateMeeting } from '../core/agenda.js';
import {
  PROPOSAL_ERRORS, PROPOSAL_NOTE_MAX, proposalStatus, validateAnnouncement, validateEvaluation, NO_EMOJI_MESSAGE, hasEmoji,
} from '../core/workflow.js';
import { EVALUATION_DECISION_ERRORS, criteriaNotesError, justificationError, pickCriterion, validateDecision } from '../core/avaliacoes.js';
import {
  CEO, ROLE_CODES, canReadAudience, permissionChangesError, roleLevel, staffChangeError,
} from '../core/permissions.js';

const STAFF_COLUMNS = 'discord_id, display_name, role, teams, active, created_at';
const EVALUATION_COLUMNS = 'id, period_id, evaluated_id, evaluator_id, status, criteria, overall, strengths, improvements, '
  + 'feedback, recommendation, created_at, updated_at, submitted_at, read_by, read_at';
/** Plano 12: com o SQL 23 (feature avaliacoes_decisoes) a avaliação tem a justificativa. */
const evaluationColumns = (staff) => ((staff?.features ?? []).includes('avaliacoes_decisoes') ? `${EVALUATION_COLUMNS}, justification` : EVALUATION_COLUMNS);
/** Nunca inclui url: o site não tem privilégio de leitura nessa coluna (10_allowlist.sql). */
const WEBHOOK_SELECT = WEBHOOK_COLUMNS.join(', ');
const ATTACHMENT_COLUMNS = 'id, evaluation_id, storage_path, file_name, mime, size, position, created_at';
const PRINTS_BUCKET = 'al-prints';
const PHOTOS_BUCKET = 'character-photos';
// '*' (e não a lista): o campo status só existe depois do SQL 18; o site funciona com o banco antigo e com o novo.
const MEETING_COLUMNS = '*, meeting_participants (kind, value)';
const ESC_PRINTS_BUCKET = 'entrevistas-prints';
const AREA_COLUMNS = 'id, nome, slug, descricao, icone, cor, nivel_minimo, status, discord_role_id, discord_canal_id, ordem, criado_por, criado_em, atualizado_em';
const AREA_PROCEDURE_COLUMNS = 'id, area_id, titulo, conteudo, status, tags, criado_por, criado_em, atualizado_por, atualizado_em';
const AREA_TAG_COLUMNS = 'id, area_id, nome, cor, discord_role_id';
const AREA_MESSAGE_COLUMNS = 'id, area_id, area_nome, tipo, canal_id, conteudo, destinatarios, enviado_por, criado_em';
const AREA_HISTORY_COLUMNS = 'id, area_id, area_nome, acao, entidade, entidade_id, ator_id, detalhes, criado_em';
const RULE_COLUMNS = 'id, title, category, content, position, created_by, created_at, updated_by, updated_at';
const CHARACTER_COLUMNS = 'id, character_name, discord_name, discord_id, city_id, photo_path, status, version, created_by, created_at, updated_by, updated_at';
const FUNCTION_NAME = 'enviar-discord';

/**
 * Busca do histórico → filtro "or" do PostgREST. Tira os caracteres que mudam a sintaxe
 * do filtro (vírgula, parênteses, aspas, curingas) e põe o valor entre aspas.
 */
export function alSearchFilter(query) {
  const q = String(query ?? '').replace(/[,()"\\%*:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!q) return null;
  return ['author_handle', 'player_discord_id', 'character_name', 'al_id'].map((c) => `${c}.ilike."%${q}%"`).join(',');
}

/** Perfil do banco → formato do contrato. */
function toStaff(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    discord_id: profile.discord_id,
    display_name: profile.display_name,
    role: profile.role,
    level: profile.level ?? roleLevel(profile.role),
    teams: [...(profile.teams ?? [])],
    permissions: [...(profile.permissions ?? [])].sort(),
    features: [...(profile.features ?? [])].sort(),
  };
}

const byTitle = (a, b) => a.title.localeCompare(b.title, 'pt-BR');
const editableOf = (p) => Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, structuredClone(p[f])]));

/** JSON com chaves ordenadas: o jsonb do Postgres reordena as chaves dos objetos. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Traduz um erro do supabase-js/PostgREST/Postgres para o código do contrato.
 * @param {{ code?: string, message?: string, status?: number }|null} error
 */
export function mapError(error, status) {
  if (!error) return null;
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (code === 'KB409') return { code: 'CONFLICT' };
  if (code === 'KB404' || code === 'PGRST116') return { code: 'NOT_FOUND' };
  if (code === 'KB422') return { code: 'VALIDATION', details: { errors: { _: message } } };
  if (code === '42501' || status === 403) return { code: 'FORBIDDEN' };
  if (status === 401 || code === 'PGRST301' || /JWT/i.test(message)) return { code: 'UNAUTHORIZED' };
  if (code === '23505') return { code: 'VALIDATION', details: { errors: { slug: 'Slug: já existe outro procedimento com este endereço.' } } };
  if (code === '23514' || code === '22P02' || code === '22023' || code === '23502') {
    return { code: 'VALIDATION', details: { errors: { _: `Dados recusados pelo banco: ${message}` } } };
  }
  if (!status || /fetch|network|Failed to/i.test(message)) return { code: 'NETWORK' };
  return { code: 'NETWORK', message: `Erro inesperado: ${message}` };
}

const failFrom = (error, status) => {
  const mapped = mapError(error, status);
  return fail(mapped.code, mapped.message, mapped.details);
};

/** Sessão do Supabase → formato do contrato. */
function toSession(session) {
  if (!session?.user) return null;
  const u = session.user;
  const discord = (u.identities ?? []).find((i) => i.provider === 'discord');
  const meta = u.user_metadata ?? {};
  return {
    user: {
      id: u.id,
      // Só para exibição; a autorização usa auth.identities no banco.
      discord_id: discord?.provider_id ?? discord?.identity_data?.provider_id ?? discord?.identity_data?.sub ?? null,
      name: meta.full_name ?? meta.custom_claims?.global_name ?? meta.name ?? 'Staff',
      avatar_url: meta.avatar_url ?? null,
    },
  };
}

/**
 * @param {{ client?: import('@supabase/supabase-js').SupabaseClient, redirectTo?: string }} [options]
 */
export function createSupabaseAdapter({ client, redirectTo } = {}) {
  const sb = client ?? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });

  let names = new Map();
  const withTeams = (m) => (m ? { ...m, teams: [...(m.teams ?? [])] } : m);

  async function session() {
    const { data, error } = await sb.auth.getSession();
    if (error) return null;
    return data.session ?? null;
  }

  async function currentStaff() {
    const s = await session();
    if (!s) return { error: fail('UNAUTHORIZED') };
    const { data, error, status } = await sb.rpc('current_staff_profile');
    if (error) return { error: failFrom(error, status) };
    return { staff: toStaff(data) };
  }

  /**
   * Garante sessão, cadastro na staff e (opcionalmente) uma permissão.
   * Devolve { staff, can } ou { error }.
   */
  async function guard(need = 'staff') {
    const { staff, error } = await currentStaff();
    if (error) return { error };
    if (!staff) return { error: fail('FORBIDDEN') };
    const can = (code) => staff.permissions.includes(code);
    if (need !== 'staff' && !can(need)) return { error: fail('FORBIDDEN') };
    return { staff, can };
  }

  async function loadNames() {
    const { data } = await sb.rpc('staff_names');
    if (Array.isArray(data)) names = new Map(data.map((r) => [r.discord_id, r.display_name]));
  }
  const nameOf = (id) => (id ? names.get(id) ?? null : null);
  /* ---------- Painel da Diretoria ---------- */
  /** Mensagem do 21_diretoria.sql → campo do formulário. */
  const DIRETORIA_FIELDS = {
    [DIRETORIA_ERRORS.member]: '_', [DIRETORIA_ERRORS.evalSelf]: 'avaliado_id', [DIRETORIA_ERRORS.evalAbove]: 'avaliado_id',
    [DIRETORIA_ERRORS.score]: 'nota_geral', [DIRETORIA_ERRORS.period]: 'periodo_fim', [DIRETORIA_ERRORS.comment]: 'comentario',
    [DIRETORIA_ERRORS.occSelf]: 'membro_id', [DIRETORIA_ERRORS.occAbove]: 'membro_id', [DIRETORIA_ERRORS.occType]: 'tipo',
    [DIRETORIA_ERRORS.occText]: 'descricao', [DIRETORIA_ERRORS.sameRole]: 'role', [DIRETORIA_ERRORS.roleUnknown]: 'role',
    [DIRETORIA_ERRORS.reason]: 'motivo', [DIRETORIA_ERRORS.rules]: 'conteudo', [AREA_EVAL_ERRORS.area]: 'area_id',
  };
  const presentDirectorEvaluation = (e) => ({
    ...e, criado_em: new Date(e.criado_em).toISOString(),
    ...Object.fromEntries(['nota_geral', 'nota_presenca', 'nota_qualidade', 'nota_colaboracao', 'nota_iniciativa'].map((k) => [k, Number(e[k])])),
    avaliado_nome: nameOf(e.avaliado_id), avaliador_nome: nameOf(e.avaliador_id),
  });
  const presentOccurrence = (o) => ({
    ...o, feito_em: new Date(o.feito_em).toISOString(), membro_nome: nameOf(o.membro_id), feito_por_nome: nameOf(o.feito_por),
  });

  /* ---------- Etapas 8 e 9 ---------- */
  /** Erro KB422 com mensagem conhecida → erro no campo certo (o resto segue o mapError). */
  function fieldFail(error, status, byMessage) {
    const field = error?.code === 'KB422' ? byMessage[error.message] : null;
    return field ? validation({ [field]: error.message }) : failFrom(error, status);
  }

  /** Gabarito e checklist: cria (sem id) ou edita; autoria pelo banco. */
  async function saveConfigRow(table, input, fields, validate, defaults) {
    const { error: g } = await guard('lore.gerenciar');
    if (g) return g;
    let current = null;
    if (input.id) {
      const { data, error, status } = await sb.from(table).select('*').eq('id', input.id).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Registro não encontrado.');
      current = data;
    }
    const next = { ...defaults, ...(current ?? {}), ...pickFields(input, fields) };
    if (!Number.isInteger(next.position)) {
      if (current) next.position = current.position;
      else {
        const { data } = await sb.from(table).select('position').order('position', { ascending: false }).limit(1);
        next.position = (data?.[0]?.position ?? 0) + 1;
      }
    }
    const { valid, errors } = validate(next);
    if (!valid) return validation(errors);
    const row = Object.fromEntries(fields.map((f) => [f, next[f]]));
    const q = current ? sb.from(table).update(row).eq('id', current.id) : sb.from(table).insert(row);
    const { data, error, status } = await q.select('*').maybeSingle();
    if (error) return failFrom(error, status);
    return data ? ok(data) : fail('NOT_FOUND', 'Registro não encontrado.');
  }

  /** Links temporários (1 hora) das fotos dos personagens. */
  async function photoUrls(rows) {
    const paths = rows.map((c) => c.photo_path).filter(Boolean);
    if (!paths.length) return new Map();
    const signed = await sb.storage.from(PHOTOS_BUCKET).createSignedUrls(paths, 3600);
    return new Map((signed.data ?? []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  }
  const presentMeeting = ({ meeting_participants: list, ...m }) => ({
    ...m,
    participants: (list ?? []).map((p) => ({ kind: p.kind, value: p.value, label: participantLabel(p, nameOf) })),
    created_by_name: nameOf(m.created_by), updated_by_name: nameOf(m.updated_by),
  });
  const presentAreaProcedure = (p) => ({ ...p, tags: p.tags ?? [], criado_por_name: nameOf(p.criado_por), atualizado_por_name: nameOf(p.atualizado_por) });
  /** Papel de quem está logado na área (null = sem vínculo). Filtra pelo próprio Discord ID: a gestão vê todos os vínculos. */
  async function myAreaRole(areaId, discordId) {
    const { data } = await sb.from('areas_membros').select('papel').eq('area_id', areaId).eq('discord_id', discordId).maybeSingle();
    return data?.papel ?? null;
  }
  const presentRule = (r) => ({ ...r, created_by_name: nameOf(r.created_by), updated_by_name: nameOf(r.updated_by) });
  const presentCharacter = (c, urls) => ({
    ...c, photo_url: c.photo_path ? urls.get(c.photo_path) ?? null : null,
    created_by_name: nameOf(c.created_by), updated_by_name: nameOf(c.updated_by),
  });

  const present = (p) => ({
    ...p,
    tags: p.tags ?? [],
    created_by_name: nameOf(p.created_by),
    updated_by_name: nameOf(p.updated_by),
    last_reviewed_by_name: nameOf(p.last_reviewed_by),
  });

  async function fetchById(id) {
    const { data, error, status } = await sb.from('procedures').select('*').eq('id', id).maybeSingle();
    if (error) return { error: failFrom(error, status) };
    if (!data) return { error: fail('NOT_FOUND', 'Procedimento não encontrado.') };
    return { proc: data };
  }

  async function conflict(id) {
    await loadNames();
    const { proc } = await fetchById(id);
    const who = nameOf(proc?.updated_by);
    return fail('CONFLICT', `Este procedimento foi alterado por ${who ?? 'outra pessoa'} enquanto você editava.`, {
      current: proc ? present(proc) : null,
      updated_by_name: who,
    });
  }

  const validation = (errors) => fail('VALIDATION', undefined, { errors });

  const adapter = {
    async getSession() {
      return ok(toSession(await session()));
    },

    async signIn() {
      const target = redirectTo ?? `${location.origin}${location.pathname}${location.hash}`;
      const { error, status } = await sb.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: target } });
      return error ? failFrom(error, status) : ok(null);
    },

    async signOut() {
      names = new Map();
      const { error } = await sb.auth.signOut();
      return error ? failFrom(error, error.status) : ok(null);
    },

    onAuthChange(cb) {
      let active = true;
      const pending = new Set();
      const { data } = sb.auth.onAuthStateChange((event, s) => {
        if (event === 'TOKEN_REFRESHED') return;
        // Consultas de sessão devem ocorrer depois que o callback liberar o lock do Auth.
        const timer = setTimeout(() => {
          pending.delete(timer);
          if (active) cb(toSession(s));
        }, 0);
        pending.add(timer);
      });
      return { data: { unsubscribe: () => {
        active = false;
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
        data.subscription.unsubscribe();
      } }, error: null };
    },

    async getCurrentStaff() {
      const { staff, error } = await currentStaff();
      return error ?? ok(staff ? { ...staff } : null);
    },

    async listProcedures({ includeArchived = false } = {}) {
      const { error: authError } = await currentStaff();
      if (authError) return authError;
      let query = sb.from('procedures').select('*');
      if (!includeArchived) query = query.neq('status', 'arquivado');
      const [{ data, error, status }] = await Promise.all([query, loadNames()]);
      if (error) return failFrom(error, status);
      return ok(data.map(present).sort(byTitle));
    },

    async getProcedure(slug) {
      const { error: authError } = await currentStaff();
      if (authError) return authError;
      const { data, error, status } = await sb.from('procedures').select('*').eq('slug', slug).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Procedimento não encontrado.');
      await loadNames();
      return ok(present(data));
    },

    async createProcedure(data) {
      const { staff, can, error: g } = await guard('procedimentos.editar');
      if (g) return g;
      const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(data) };
      if (next.status === 'arquivado' && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
      const { valid, errors } = validateProcedure(next);
      if (!valid) return validation(errors);
      if (!canReadAudience(staff.permissions, next.audience)) return fail('FORBIDDEN');
      const { data: row, error, status } = await sb.from('procedures').insert(editableOf(next)).select('*').single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(row));
    },

    async updateProcedure(id, data, expectedVersion) {
      const { staff, can, error: g } = await guard();
      if (g) return g;
      const { proc: old, error: e } = await fetchById(id);
      if (e) return e;
      if (!can('procedimentos.editar')) return fail('FORBIDDEN');
      const next = { ...editableOf(old), ...pickEditable(data) };
      const touchesArchive = old.status === 'arquivado' || next.status === 'arquivado';
      if (touchesArchive && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
      if (!Number.isInteger(expectedVersion)) return validation({ version: 'Versão: informe a versão que você estava editando.' });
      if (expectedVersion !== old.version) return conflict(id);
      const { valid, errors } = validateProcedure(next);
      if (!valid) return validation(errors);
      if (!canReadAudience(staff.permissions, next.audience)) return fail('FORBIDDEN');
      const { data: row, error, status } = await sb.from('procedures')
        .update({ ...editableOf(next), version: expectedVersion }).eq('id', id).select('*').single();
      if (error) return error.code === 'KB409' ? conflict(id) : failFrom(error, status);
      await loadNames();
      return ok(present(row));
    },

    async setStatus(id, statusValue) {
      const { can, error: g } = await guard();
      if (g) return g;
      const { proc: old, error: e } = await fetchById(id);
      if (e) return e;
      if (!can('procedimentos.editar')) return fail('FORBIDDEN');
      if (!STATUSES.includes(statusValue)) return validation({ status: 'Status: use ativo, revisar ou arquivado.' });
      if ((old.status === 'arquivado' || statusValue === 'arquivado') && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
      const { data: row, error, status } = await sb.from('procedures')
        .update({ status: statusValue, version: old.version }).eq('id', id).select('*').single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(row));
    },

    async markReviewed(id) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('mark_reviewed', { p_id: id }).single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(data));
    },

    async listRevisions(procedureId) {
      const { error: authError } = await currentStaff();
      if (authError) return authError;
      const { data, error, status } = await sb.from('procedure_revisions')
        .select('*').eq('procedure_id', procedureId).order('version', { ascending: false });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map((r) => ({ ...r, snapshot: present(r.snapshot), changed_by_name: nameOf(r.changed_by) })));
    },

    async restoreRevision(revisionId) {
      const { error: g } = await guard('procedimentos.arquivar');
      if (g) return g;
      const { data, error, status } = await sb.rpc('restore_revision', { p_revision_id: revisionId }).single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(data));
    },

    async listFavorites() {
      const { error: authError } = await currentStaff();
      if (authError) return authError;
      const { data, error, status } = await sb.from('favorites').select('procedure_id');
      if (error) return failFrom(error, status);
      return ok(data.map((r) => r.procedure_id));
    },

    async addFavorite(procedureId) {
      const { can, error: g } = await guard();
      if (g) return g;
      const { proc, error: e } = await fetchById(procedureId);
      if (e || !proc) return e ?? fail('NOT_FOUND');
      if (!can('procedimentos.favoritar')) return fail('FORBIDDEN');
      const { error, status } = await sb.from('favorites')
        .upsert({ procedure_id: procedureId }, { onConflict: 'user_id,procedure_id', ignoreDuplicates: true });
      return error ? failFrom(error, status) : ok(null);
    },

    async removeFavorite(procedureId) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.from('favorites').delete().eq('procedure_id', procedureId);
      return error ? failFrom(error, status) : ok(null);
    },

    async exportAll() {
      const { error: g } = await guard('procedimentos.backup');
      if (g) return g;
      const { data, error, status } = await sb.from('procedures').select('*');
      if (error) return failFrom(error, status);
      return ok({ format: EXPORT_FORMAT, version: 1, exported_at: new Date().toISOString(), procedures: data.sort(byTitle) });
    },

    async importAll(payload, { dryRun = false } = {}) {
      const { can, error: g } = await guard('procedimentos.backup');
      if (g) return g;
      if (!can('procedimentos.editar')) return fail('FORBIDDEN');
      if (!payload || payload.format !== EXPORT_FORMAT || !Array.isArray(payload.procedures)) {
        return validation({ payload: `Arquivo: formato inválido (esperado "${EXPORT_FORMAT}" com a lista de procedimentos).` });
      }
      const items = [];
      const seen = new Set();
      const plan = [];
      payload.procedures.forEach((raw, index) => {
        const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(raw) };
        const { errors } = validateProcedure(next);
        if (next.slug && seen.has(next.slug)) errors.slug = 'Slug: repetido no arquivo.';
        seen.add(next.slug);
        if (Object.keys(errors).length) items.push({ index, slug: next.slug ?? null, errors });
        else plan.push(editableOf(next));
      });
      if (items.length) return fail('VALIDATION', `${items.length} procedimento(s) inválido(s) no arquivo.`, { items });

      if (dryRun) {
        const { data, error, status } = await sb.from('procedures').select('*');
        if (error) return failFrom(error, status);
        const bySlug = new Map(data.map((p) => [p.slug, editableOf({ ...p, tags: p.tags ?? [] })]));
        const summary = { created: 0, updated: 0, unchanged: 0 };
        for (const next of plan) {
          const existing = bySlug.get(next.slug);
          if (!existing) summary.created++;
          else if (stableStringify(existing) === stableStringify(next)) summary.unchanged++;
          else summary.updated++;
        }
        return ok(summary);
      }
      const { data, error, status } = await sb.rpc('import_procedures', { items: plan });
      if (error) return failFrom(error, status);
      return ok({ created: data.created, updated: data.updated, unchanged: data.unchanged });
    },

    /* ----- equipe (staff_members; RLS e trigger em supabase/05_staff_admin.sql) ----- */
    async listStaff() {
      const { error: g } = await guard('equipe.ver');
      if (g) return g;
      const { data, error, status } = await sb.from('staff_members').select(STAFF_COLUMNS);
      if (error) return failFrom(error, status);
      return ok(data.map(withTeams).sort(byStaffName));
    },

    async createStaffMember(member) {
      const { staff, error: g } = await guard('equipe.gerenciar');
      if (g) return g;
      const next = pickStaffMember(member);
      const { valid, errors } = validateStaffMember(next);
      if (!valid) return validation(errors);
      // O último CEO só é conferido pelo banco (aqui não há a lista completa).
      const blocked = staffChangeError(staff, null, next);
      if (blocked) return validation({ _: blocked });
      const { data, error, status } = await sb.from('staff_members').insert(next).select(STAFF_COLUMNS).single();
      if (error?.code === '23505') return validation({ discord_id: 'Discord ID: já cadastrado na staff.' });
      if (error) return failFrom(error, status);
      names = new Map();
      return ok(withTeams(data));
    },

    async updateStaffMember(discordId, changes) {
      const { staff, error: g } = await guard('equipe.gerenciar');
      if (g) return g;
      const patch = pickStaffMember(changes, { partial: true });
      delete patch.discord_id;
      const { data: found, error: e, status: s } = await sb.from('staff_members')
        .select(STAFF_COLUMNS).eq('discord_id', discordId).maybeSingle();
      if (e) return failFrom(e, s);
      if (!found) return fail('NOT_FOUND', 'Membro não encontrado.');
      const old = withTeams(found);
      const next = { ...old, ...patch };
      const { valid, errors } = validateStaffMember(next);
      if (!valid) return validation(errors);
      const blocked = staffChangeError(staff, old, next);
      if (blocked) return validation({ _: blocked });
      const { data, error, status } = await sb.from('staff_members')
        .update(patch).eq('discord_id', discordId).select(STAFF_COLUMNS).single();
      if (error) return failFrom(error, status);
      names = new Map();
      return ok(withTeams(data));
    },

    async deleteStaffMember(discordId) {
      const { staff, error: g } = await guard('equipe.gerenciar');
      if (g) return g;
      const { data: found, error: e, status: s } = await sb.from('staff_members')
        .select(STAFF_COLUMNS).eq('discord_id', discordId).maybeSingle();
      if (e) return failFrom(e, s);
      if (!found) return fail('NOT_FOUND', 'Membro não encontrado.');
      const blocked = staffChangeError(staff, withTeams(found), 'delete');
      if (blocked) return validation({ _: blocked });
      const { data, error, status } = await sb.from('staff_members')
        .delete().eq('discord_id', discordId).select('discord_id');
      if (error) return failFrom(error, status);
      if (!data?.length) return fail('NOT_FOUND', 'Membro não encontrado.');
      names = new Map();
      return ok(null);
    },

    /* ----- grade de permissões (role_permissions; RLS no 03, travas e RPC no 02) ----- */
    async listPermissionGrid() {
      const { error: g } = await guard();
      if (g) return g;
      return readGrid();
    },

    async setPermissions(changes) {
      const { staff, error: g } = await guard('permissoes.editar');
      if (g) return g;
      const blocked = permissionChangesError(staff.role, changes);
      if (blocked) return validation({ _: blocked });
      if (changes.length) {
        // Uma chamada = uma transação no banco: tudo ou nada.
        const { error, status } = await sb.rpc('set_role_permissions', {
          p_changes: changes.map(({ role, permission, allowed }) => ({ role, permission, allowed })),
        });
        if (error) return failFrom(error, status);
      }
      return readGrid();
    },

    /* ----- Etapa 2B: propostas (supabase/07_aprovacao.sql) ----- */
    async listProposals() {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('procedure_proposals').select('*').order('created_at', { ascending: false });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentProposal));
    },

    async createProposal({ procedure_id: procedureId = null, base_version: baseVersion = null, data } = {}) {
      const { error: g } = await guard('procedimentos.editar');
      if (g) return g;
      let current = null;
      if (procedureId) {
        const found = await fetchById(procedureId);
        if (found.error) return found.error;
        current = found.proc;
        if (!Number.isInteger(baseVersion)) return validation({ version: 'Versão: informe a versão que você estava editando.' });
      }
      const next = { ...PROCEDURE_DEFAULTS, ...(current ? editableOf(current) : {}), ...pickEditable(data) };
      next.status = proposalStatus(next);
      const { valid, errors } = validateProcedure(next);
      if (!valid) return validation(errors);
      const { data: taken } = await sb.from('procedures').select('id').eq('slug', next.slug);
      if (taken?.some((r) => r.id !== current?.id)) return validation({ slug: 'Slug: já existe outro procedimento com este endereço.' });
      const { data: row, error, status } = await sb.from('procedure_proposals')
        .insert({ procedure_id: procedureId, base_version: procedureId ? baseVersion : null, data: editableOf(next) })
        .select('*').single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(presentProposal(row));
    },

    async cancelProposal(id) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.rpc('cancel_procedure_proposal', { p_id: id });
      if (error) return error.code === 'KB404' ? fail('NOT_FOUND', 'Proposta não encontrada ou já analisada.') : failFrom(error, status);
      return ok(null);
    },

    async reviewProposal(id, { approve, note = '' } = {}) {
      const { error: g } = await guard('procedimentos.aprovar');
      if (g) return g;
      const text = String(note ?? '').trim();
      if (text.length > PROPOSAL_NOTE_MAX) return validation({ _: PROPOSAL_ERRORS.noteMax });
      if (!approve && !text) return validation({ _: PROPOSAL_ERRORS.rejectNote });
      const { data, error, status } = await sb.rpc('review_procedure_proposal', { p_id: id, p_approve: Boolean(approve), p_note: text });
      if (error) return failFrom(error, status);
      return ok({ status: data.status, procedure_id: data.procedure_id });
    },

    /* ----- Etapa 3: avaliações (supabase/08_avaliacoes.sql) ----- */
    async listEvaluationPeriods() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!seesEvaluations(can)) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('staff_evaluation_periods').select('*').order('starts_at', { ascending: false });
      return error ? failFrom(error, status) : ok(data);
    },

    async saveEvaluationPeriod(period = {}) {
      const { error: g } = await guard('avaliacoes.gerenciar');
      if (g) return g;
      const title = String(period.title ?? '').trim();
      const errors = {};
      if (!title || title.length > 80) errors.title = 'Nome do período: de 1 a 80 caracteres.';
      const startsAt = period.starts_at ?? new Date().toISOString();
      if (!period.ends_at || !(new Date(period.ends_at) > new Date(startsAt))) errors.ends_at = 'Fim: precisa ser depois do início.';
      if (Object.keys(errors).length) return validation(errors);
      const row = { title, starts_at: startsAt, ends_at: period.ends_at };
      const q = period.id
        ? sb.from('staff_evaluation_periods').update(row).eq('id', period.id)
        : sb.from('staff_evaluation_periods').insert(row);
      const { data, error, status } = await q.select('*').maybeSingle();
      if (error) return failFrom(error, status);
      return data ? ok(data) : fail('NOT_FOUND', 'Período não encontrado.');
    },

    async listEvaluationCriteria() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!seesEvaluations(can)) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('staff_evaluation_criteria').select('id, label, sort_order, active').order('sort_order');
      return error ? failFrom(error, status) : ok(data);
    },

    async saveEvaluationCriterion(c = {}) {
      const { error: g } = await guard('avaliacoes.gerenciar');
      if (g) return g;
      const label = String(c.label ?? '').trim();
      if (!label || label.length > 80) return validation({ label: 'Critério: de 1 a 80 caracteres.' });
      const row = { label };
      if (Number.isInteger(c.sort_order)) row.sort_order = c.sort_order;
      if (typeof c.active === 'boolean') row.active = c.active;
      if (!c.id && row.sort_order == null) {
        const { data: last } = await sb.from('staff_evaluation_criteria').select('sort_order').order('sort_order', { ascending: false }).limit(1);
        row.sort_order = (last?.[0]?.sort_order ?? 0) + 1;
      }
      const q = c.id ? sb.from('staff_evaluation_criteria').update(row).eq('id', c.id) : sb.from('staff_evaluation_criteria').insert(row);
      const { data, error, status } = await q.select('id, label, sort_order, active').maybeSingle();
      if (error) return failFrom(error, status);
      return data ? ok(data) : fail('NOT_FOUND', 'Critério não encontrado.');
    },

    async listEvaluableMembers() {
      const { error: g } = await guard('avaliacoes.criar');
      if (g) return g;
      const { data, error, status } = await sb.rpc('evaluable_members');
      return error ? failFrom(error, status) : ok(data ?? []);
    },

    async listEvaluations() {
      const { staff, error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('staff_evaluations').select(evaluationColumns(staff));
      if (error) return failFrom(error, status);
      await loadNames();
      const when = (e) => e.submitted_at ?? e.updated_at;
      return ok(data.sort((a, b) => when(b).localeCompare(when(a))).map(presentEvaluation));
    },

    async saveEvaluation(input = {}) {
      const { staff, error: g } = await guard('avaliacoes.criar');
      if (g) return g;
      // Plano 12: justificativa e notas por critério só com o SQL 23; sem ele, o site antigo continua igual.
      const plus = (staff.features ?? []).includes('avaliacoes_decisoes');
      const columns = evaluationColumns(staff);
      let before = null;
      if (input.id) {
        const { data, error, status } = await sb.from('staff_evaluations').select(columns).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Avaliação não encontrada.');
        before = data;
      }
      const fields = ['period_id', 'evaluated_id', 'status', 'criteria', 'overall', 'strengths', 'improvements', 'feedback', 'recommendation',
        ...(plus ? ['justification'] : [])];
      const after = { ...(before ?? { status: 'rascunho', criteria: [], overall: null, strengths: '', improvements: '', feedback: '', recommendation: null, justification: '' }) };
      for (const f of fields) if (f in input) after[f] = structuredClone(input[f]);
      for (const f of ['strengths', 'improvements', 'feedback', 'justification']) after[f] = String(after[f] ?? '');
      after.overall = after.overall ?? null;
      after.recommendation = after.recommendation || null;
      if (Array.isArray(after.criteria)) after.criteria = after.criteria.map((c) => (c && typeof c === 'object' && typeof c.id === 'string' ? pickCriterion(c, { notes: plus }) : c));
      const { valid, errors } = validateEvaluation(after);
      if (!valid) return validation(errors);
      if (plus) {
        const notes = criteriaNotesError(after.criteria);
        if (notes) return validation({ criteria: notes });
        const why = justificationError(after);
        if (why) return validation({ justification: why });
      }
      const row = Object.fromEntries(fields.map((f) => [f, after[f]]));
      const q = before
        ? sb.from('staff_evaluations').update(row).eq('id', before.id)
        : sb.from('staff_evaluations').insert(row);
      const { data, error, status } = await q.select(columns).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Avaliação não encontrada.');
      await loadNames();
      return ok(presentEvaluation(data));
    },

    async deleteEvaluation(id) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('staff_evaluations').delete().eq('id', id).eq('status', 'rascunho').select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Rascunho não encontrado.');
    },

    async markEvaluationRead(id) {
      const { error: g } = await guard('avaliacoes.ler');
      if (g) return g;
      const { error, status } = await sb.rpc('mark_staff_evaluation_read', { p_id: id });
      return error ? failFrom(error, status) : ok(null);
    },

    async archiveEvaluation(id) {
      const { error: g } = await guard('avaliacoes.gerenciar');
      if (g) return g;
      const { error, status } = await sb.rpc('archive_staff_evaluation', { p_id: id });
      return error ? failFrom(error, status) : ok(null);
    },

    /* ----- Plano 12: decisões da Direção, cobertura e lembretes (supabase/23_avaliacoes_decisoes.sql) ----- */
    async listEvaluationDecisions() {
      const { error: g } = await guard('diretoria.ver');
      if (g) return g;
      const { data, error, status } = await sb.from('staff_evaluation_decisions').select('*').order('decided_at', { ascending: false });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map((d) => ({ ...d, decided_at: new Date(d.decided_at).toISOString(), evaluated_name: nameOf(d.evaluated_id), decided_by_name: nameOf(d.decided_by) })));
    },

    async registerEvaluationDecision(input = {}) {
      const { error: g } = await guard('diretoria.ver');
      if (g) return g;
      const d = {
        evaluation_id: String(input.evaluation_id ?? ''), decision: String(input.decision ?? ''), action: String(input.action ?? ''),
        reason: String(input.reason ?? ''),
      };
      // Checagem rápida dos campos (a recomendação e o alvo o banco confere).
      const { valid, errors } = validateDecision({ recommendation: input.recommendation ?? null }, d);
      if (!valid) return validation(errors);
      if (hasEmoji(d.reason)) return validation({ reason: NO_EMOJI_MESSAGE });
      const { data: id, error, status } = await sb.rpc('registrar_decisao_avaliacao', {
        p_avaliacao: d.evaluation_id, p_decisao: d.decision, p_acao: d.action || null, p_motivo: d.reason,
      });
      if (error) {
        if (error.code === 'KB404') return fail('NOT_FOUND', error.message);
        if (error.code === 'KB422') {
          const field = { [EVALUATION_DECISION_ERRORS.action]: 'action', [EVALUATION_DECISION_ERRORS.sameAction]: 'action', [EVALUATION_DECISION_ERRORS.reason]: 'reason', [NO_EMOJI_MESSAGE]: 'reason' }[error.message] ?? '_';
          return validation({ [field]: error.message });
        }
        return failFrom(error, status);
      }
      const { data, error: e2, status: s2 } = await sb.from('staff_evaluation_decisions').select('*').eq('id', id).maybeSingle();
      if (e2) return failFrom(e2, s2);
      await loadNames();
      return ok({ ...data, decided_at: new Date(data.decided_at).toISOString(), evaluated_name: nameOf(data.evaluated_id), decided_by_name: nameOf(data.decided_by) });
    },

    async getEvaluationCoverage(periodId) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('avaliacoes.ler') && !can('avaliacoes.gerenciar')) return fail('FORBIDDEN', EVALUATION_DECISION_ERRORS.coverage);
      const { data, error, status } = await sb.rpc('avaliacao_cobertura', { p_periodo: periodId });
      if (error) return failFrom(error, status);
      return ok((data ?? []).map((c) => ({ ...c, enviadas: Number(c.enviadas) })));
    },

    async listEvaluationReminders(periodId = '') {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('avaliacoes.ler') && !can('avaliacoes.gerenciar')) return fail('FORBIDDEN');
      let q = sb.from('staff_evaluation_reminders').select('*').order('sent_at', { ascending: false });
      if (periodId) q = q.eq('period_id', periodId);
      const { data, error, status } = await q;
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map((r) => ({ ...r, sent_at: new Date(r.sent_at).toISOString(), sent_by_name: nameOf(r.sent_by) })));
    },

    async sendEvaluationReminder({ period_id: periodId, kind, siteUrl = '' } = {}) {
      const { error: g } = await guard('avaliacoes.gerenciar');
      if (g) return g;
      if (!EVALUATION_REMINDER_KINDS.includes(kind)) return validation({ _: EVALUATION_REMINDER_ERRORS.kind });
      const res = await invokeSend({ action: 'lembrete_avaliacao', period_id: periodId, kind, site_url: siteUrl });
      if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', EVALUATION_REMINDER_ERRORS.outdatedFunction);
      return res;
    },

    /* ----- Etapa 11: avisos (supabase/09_avisos_auditoria.sql) ----- */
    async listAnnouncements() {
      const { staff, error: g } = await guard();
      if (g) return g;
      const [list, reads] = await Promise.all([
        sb.from('announcements').select('*').order('starts_at', { ascending: false }),
        sb.from('announcement_reads').select('announcement_id, read_at, acknowledged_at').eq('discord_id', staff.discord_id),
      ]);
      if (list.error) return failFrom(list.error, list.status);
      if (reads.error) return failFrom(reads.error, reads.status);
      await loadNames();
      const mine = new Map(reads.data.map((r) => [r.announcement_id, r]));
      return ok(list.data.map((a) => ({
        ...a, audience_roles: [...(a.audience_roles ?? [])], created_by_name: nameOf(a.created_by),
        my_read_at: mine.get(a.id)?.read_at ?? null, my_acknowledged_at: mine.get(a.id)?.acknowledged_at ?? null,
      })));
    },

    async saveAnnouncement(input = {}) {
      const { error: g } = await guard('avisos.enviar');
      if (g) return g;
      const next = {
        title: String(input.title ?? '').trim(), body: String(input.body ?? ''), priority: input.priority ?? 'normal',
        audience_roles: [...new Set(input.audience_roles ?? [])].sort(), starts_at: input.starts_at ?? new Date().toISOString(),
        ends_at: input.ends_at || null, requires_ack: Boolean(input.requires_ack),
      };
      const { valid, errors } = validateAnnouncement(next);
      if (!valid) return validation(errors);
      const q = input.id ? sb.from('announcements').update(next).eq('id', input.id) : sb.from('announcements').insert(next);
      const { data, error, status } = await q.select('*').maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Aviso não encontrado.');
      await loadNames();
      return ok({ ...data, created_by_name: nameOf(data.created_by), my_read_at: null, my_acknowledged_at: null });
    },

    async deleteAnnouncement(id) {
      const { error: g } = await guard('avisos.enviar');
      if (g) return g;
      const { data, error, status } = await sb.from('announcements').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Aviso não encontrado.');
    },

    async markAnnouncementRead(id, { ack = false } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.rpc('mark_announcement_read', { p_id: id, p_ack: Boolean(ack) });
      if (error) return error.code === 'KB404' ? fail('NOT_FOUND', 'Aviso não encontrado.') : failFrom(error, status);
      return ok(null);
    },

    async getAnnouncementReport(id) {
      const { error: g } = await guard('avisos.enviar');
      if (g) return g;
      const { data, error, status } = await sb.rpc('announcement_read_report', { p_id: id });
      return error ? failFrom(error, status) : ok(data ?? []);
    },

    /* ----- Etapa 11: auditoria ----- */
    async listAudit({ entity = '', entityId = '', limit = 100, before = null } = {}) {
      const { error: g } = await guard('auditoria.ver');
      if (g) return g;
      let q = sb.from('audit_log').select('*').order('id', { ascending: false }).limit(Math.min(Math.max(1, limit), 500));
      if (entity) q = q.eq('entity', entity);
      if (entityId) q = q.eq('entity_id', entityId);
      if (before != null) q = q.lt('id', before);
      const { data, error, status } = await q;
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map((a) => ({ ...a, actor_name: nameOf(a.actor) })));
    },

    /* ----- Etapa 5: gabarito, checklist e nomes proibidos (supabase/10_allowlist.sql) ----- */
    async listInterviewQuestions({ includeInactive = false } = {}) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!usesAllowlist(can)) return fail('FORBIDDEN', ALLOWLIST_ERRORS.forbidden);
      let q = sb.from('interview_questions').select('*').order('position');
      if (!includeInactive) q = q.eq('active', true);
      const { data, error, status } = await q;
      return error ? failFrom(error, status) : ok(data);
    },

    async listChecklistItems({ includeInactive = false } = {}) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!usesAllowlist(can)) return fail('FORBIDDEN', ALLOWLIST_ERRORS.forbidden);
      let q = sb.from('al_checklist_items').select('*').order('stage').order('position');
      if (!includeInactive) q = q.eq('active', true);
      const { data, error, status } = await q;
      return error ? failFrom(error, status) : ok(data);
    },

    async listBlockedNames({ includeInactive = false } = {}) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!usesAllowlist(can) && !can('lore.consultar')) return fail('FORBIDDEN');
      let q = sb.from('blocked_names').select('*').order('name');
      if (!includeInactive) q = q.eq('active', true);
      const { data, error, status } = await q;
      return error ? failFrom(error, status) : ok(data.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
    },

    /* ----- Etapa 5: análises de allowlist e entrevistas ----- */
    async listAlEvaluations({ kind = '', status: st = '', createdBy = '', query = '', limit = 100, before = null } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      let q = sb.from('al_evaluations').select('*').order('created_at', { ascending: false }).limit(Math.min(Math.max(1, limit), 200));
      if (kind) q = q.eq('kind', kind);
      if (st) q = q.eq('status', st);
      if (createdBy) q = q.eq('created_by', createdBy);
      if (before) q = q.lt('created_at', before);
      const search = alSearchFilter(query);
      if (search) q = q.or(search);
      const { data, error, status } = await q;
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentAl));
    },

    async getAlEvaluation(id) {
      const { error: g } = await guard();
      if (g) return g;
      return alDetail(id);
    },

    async saveAlEvaluation(input = {}) {
      const { staff, error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      let before = null;
      if (input.id) {
        const found = await fetchAl(input.id);
        if (found.error) return found.error;
        before = found.row;
        if (before.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (before.sent_to_discord_at) return validation({ _: ALLOWLIST_ERRORS.sent });
      }
      const next = { ...(before ?? { ...structuredClone(AL_DEFAULTS), kind: input.kind }), ...pickAlEvaluation(input) };
      const { valid, errors } = validateAlEvaluation(next);
      const answers = Array.isArray(input.answers) ? pickAlAnswers(input.answers) : null;
      const participants = Array.isArray(input.participants) ? pickAlParticipants(input.participants, staff.discord_id) : null;
      const extras = validateAlExtras(next.kind, { answers, participants });
      if (!valid || !extras.valid) return validation({ ...errors, ...extras.errors });
      const fields = pickAlEvaluation(next);
      const q = before
        ? sb.from('al_evaluations').update(fields).eq('id', before.id)
        : sb.from('al_evaluations').insert({ kind: next.kind, ...fields });
      const { data: row, error, status } = await q.select('*').maybeSingle();
      if (error) return failFrom(error, status);
      if (!row) return fail('NOT_FOUND', 'Análise não encontrada.');
      // Respostas e participantes: substitui os atuais (se o passo falhar, a análise já está salva;
      // salvar de novo com o id completa).
      if (answers) {
        const del = await sb.from('al_evaluation_answers').delete().eq('evaluation_id', row.id);
        if (del.error) return failFrom(del.error, del.status);
        if (answers.length) {
          const ins = await sb.from('al_evaluation_answers').insert(answers.map((a) => ({ evaluation_id: row.id, ...a })));
          if (ins.error) return failFrom(ins.error, ins.status);
        }
      }
      if (participants) {
        const del = await sb.from('al_evaluation_participants').delete().eq('evaluation_id', row.id).neq('role', 'responsavel');
        if (del.error) return failFrom(del.error, del.status);
        if (participants.length) {
          const ins = await sb.from('al_evaluation_participants').insert(participants.map((p) => ({ evaluation_id: row.id, ...p })));
          if (ins.error) return failFrom(ins.error, ins.status);
        }
      }
      return alDetail(row.id);
    },

    async addAlPrint(evaluationId, file) {
      const { staff, error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      const found = await fetchAl(evaluationId);
      if (found.error) return found.error;
      if (found.row.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
      if (found.row.sent_to_discord_at) return validation({ _: ALLOWLIST_ERRORS.sent });
      const used = await sb.from('al_attachments').select('position').eq('evaluation_id', evaluationId);
      if (used.error) return failFrom(used.error, used.status);
      const bad = printError(file, used.data.length);
      if (bad) return validation({ file: bad });
      const position = [...Array(MAX_PRINTS).keys()].map((i) => i + 1).find((p) => !used.data.some((a) => a.position === p));
      const path = `${evaluationId}/${globalThis.crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`;
      const up = await sb.storage.from(PRINTS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) return failFrom(up.error, up.error.statusCode ?? up.error.status);
      const { data, error, status } = await sb.from('al_attachments').insert({
        evaluation_id: evaluationId, storage_path: path, file_name: String(file.name ?? '').slice(0, 200),
        mime: file.type, size: file.size, position,
      }).select(ATTACHMENT_COLUMNS).single();
      if (error) {
        await sb.storage.from(PRINTS_BUCKET).remove([path]);
        return failFrom(error, status);
      }
      return ok(presentAttachment(data));
    },

    async removeAlPrint(attachmentId) {
      const { staff, error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      const { data: att, error: e, status: s } = await sb.from('al_attachments').select(ATTACHMENT_COLUMNS).eq('id', attachmentId).maybeSingle();
      if (e) return failFrom(e, s);
      if (!att) return fail('NOT_FOUND', 'Print não encontrado.');
      const found = await fetchAl(att.evaluation_id);
      if (found.error) return found.error;
      if (found.row.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
      if (found.row.sent_to_discord_at) return validation({ _: ALLOWLIST_ERRORS.sent });
      const { data, error, status } = await sb.from('al_attachments').delete().eq('id', attachmentId).select('id');
      if (error) return failFrom(error, status);
      if (!data?.length) return fail('NOT_FOUND', 'Print não encontrado.');
      // Se o arquivo não sair do Storage, sobra só o arquivo (a limpeza de 90 dias apaga).
      await sb.storage.from(PRINTS_BUCKET).remove([att.storage_path]);
      return ok(null);
    },

    async getAlPrintUrls(evaluationId) {
      const { error: g } = await guard();
      if (g) return g;
      const found = await fetchAl(evaluationId);
      if (found.error) return found.error;
      const { data, error, status } = await sb.from('al_attachments').select(ATTACHMENT_COLUMNS)
        .eq('evaluation_id', evaluationId).order('position');
      if (error) return failFrom(error, status);
      if (!data.length) return ok([]);
      const signed = await sb.storage.from(PRINTS_BUCKET).createSignedUrls(data.map((a) => a.storage_path), 3600);
      if (signed.error) return failFrom(signed.error, signed.error.statusCode ?? signed.error.status);
      const byPath = new Map((signed.data ?? []).map((x) => [x.path, x.signedUrl]));
      return ok(data.filter((a) => byPath.get(a.storage_path)).map((a) => ({ id: a.id, url: byPath.get(a.storage_path) })));
    },

    /* ----- Etapa 5: webhooks do Discord (a url nunca é lida) ----- */
    async listDiscordWebhooks({ purpose = '' } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      let q = sb.from('discord_webhooks').select(WEBHOOK_SELECT).order('name');
      if (purpose) q = q.eq('purpose', purpose);
      const { data, error, status } = await q;
      return error ? failFrom(error, status) : ok(data.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
    },

    async saveDiscordWebhook(input = {}) {
      const { error: g } = await guard('webhooks.gerenciar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('discord_webhooks').select(WEBHOOK_SELECT).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Webhook não encontrado.');
        current = data;
      }
      const patch = pickWebhook(input);
      const next = { channel_name: '', sender_name: '', sender_avatar_url: '', active: true, ...(current ?? {}), ...patch };
      const { valid, errors } = validateWebhook(next, { creating: !current });
      if (!valid) return validation(errors);
      if (current && !Object.keys(patch).length) return ok(current);
      const row = current ? patch : {
        name: next.name, url: next.url, purpose: next.purpose, channel_name: next.channel_name,
        sender_name: next.sender_name, sender_avatar_url: next.sender_avatar_url, active: next.active,
      };
      const q = current
        ? sb.from('discord_webhooks').update(row).eq('id', current.id)
        : sb.from('discord_webhooks').insert(row);
      const { data, error, status } = await q.select(WEBHOOK_SELECT).maybeSingle();
      if (error) return failFrom(error, status);
      return data ? ok(data) : fail('NOT_FOUND', 'Webhook não encontrado.');
    },

    async deleteDiscordWebhook(id) {
      const { error: g } = await guard('webhooks.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.from('discord_webhooks').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Webhook não encontrado.');
    },

    /* ----- Etapa 8: gabarito, checklist e nomes proibidos (lore.gerenciar) ----- */
    async saveInterviewQuestion(input = {}) {
      return saveConfigRow('interview_questions', input, QUESTION_FIELDS, validateQuestion, { answer: '', extra_note: '', active: true });
    },

    async saveChecklistItem(input = {}) {
      return saveConfigRow('al_checklist_items', input, CHECKLIST_FIELDS, validateChecklistItem, { hint: '', active: true });
    },

    async saveBlockedName(input = {}) {
      const { error: g } = await guard('lore.gerenciar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('blocked_names').select('*').eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Nome não encontrado.');
        current = data;
      }
      if (current?.reason === 'em_uso' || (!current && input.reason === 'em_uso')) return validation({ _: ALLOWLIST_ERRORS.nameInUse });
      const patch = pickFields(input, BLOCKED_NAME_FIELDS);
      const next = { series: '', reason_text: '', mode: 'bloqueia', active: true, ...(current ?? {}), ...patch };
      const { valid, errors } = validateBlockedName(next);
      if (!valid) return validation(errors);
      const row = Object.fromEntries(BLOCKED_NAME_FIELDS.map((f) => [f, next[f]]));
      const q = current ? sb.from('blocked_names').update(row).eq('id', current.id) : sb.from('blocked_names').insert(row);
      const { data, error, status } = await q.select('*').maybeSingle();
      if (error) return fieldFail(error, status, { [ALLOWLIST_ERRORS.nameDuplicate]: 'name' });
      return data ? ok(data) : fail('NOT_FOUND', 'Nome não encontrado.');
    },

    /* ----- Etapa 9: personagens em uso (12_lore.sql) ----- */
    async listCharacters() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('lore.consultar') && !can('lore.gerenciar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('lore_characters').select(CHARACTER_COLUMNS).order('character_name');
      if (error) return failFrom(error, status);
      await loadNames();
      const urls = await photoUrls(data);
      return ok(data.map((c) => presentCharacter(c, urls)).sort((a, b) => a.character_name.localeCompare(b.character_name, 'pt-BR')));
    },

    async getCharacter(id) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('lore.consultar') && !can('lore.gerenciar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('lore_characters').select(CHARACTER_COLUMNS).eq('id', id).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Personagem não encontrado.');
      const [revs, notes] = await Promise.all([
        sb.from('lore_character_revisions').select('*').eq('character_id', id).order('version', { ascending: false }),
        can('lore.anotacoes') ? sb.rpc('character_notes', { p_character: id }) : Promise.resolve({ data: [] }),
        loadNames(),
      ]);
      if (revs.error) return failFrom(revs.error, revs.status);
      if (notes.error) return failFrom(notes.error, notes.status);
      const urls = await photoUrls([data]);
      return ok({
        ...presentCharacter(data, urls),
        revisions: revs.data.map((r) => ({ ...r, changed_by_name: nameOf(r.changed_by) })),
        notes: (notes.data ?? []).map((n) => ({ ...n, created_by_name: nameOf(n.created_by) })),
      });
    },

    async saveCharacter(input = {}) {
      const { error: g } = await guard('lore.gerenciar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('lore_characters').select(CHARACTER_COLUMNS).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Personagem não encontrado.');
        current = data;
      }
      const next = { status: 'ativo', ...(current ? pickCharacter(current) : {}), ...pickCharacter(input) };
      const { valid, errors } = validateCharacter(next);
      if (!valid) return validation(errors);
      const q = current ? sb.from('lore_characters').update(next).eq('id', current.id) : sb.from('lore_characters').insert(next);
      const { data, error, status } = await q.select(CHARACTER_COLUMNS).maybeSingle();
      if (error) return fieldFail(error, status, { [LORE_ERRORS.duplicateCharacter]: 'character_name', [LORE_ERRORS.duplicateCityId]: 'city_id' });
      if (!data) return fail('NOT_FOUND', 'Personagem não encontrado.');
      await loadNames();
      return ok(presentCharacter(data, await photoUrls([data])));
    },

    async setCharacterPhoto(id, file) {
      const { error: g } = await guard('lore.gerenciar');
      if (g) return g;
      const { data: c, error: e, status: s } = await sb.from('lore_characters').select(CHARACTER_COLUMNS).eq('id', id).maybeSingle();
      if (e) return failFrom(e, s);
      if (!c) return fail('NOT_FOUND', 'Personagem não encontrado.');
      let path = null;
      if (file) {
        const bad = photoError(file);
        if (bad) return validation({ file: bad });
        path = `${id}/${globalThis.crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`;
        const up = await sb.storage.from(PHOTOS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
        if (up.error) return failFrom(up.error, up.error.statusCode ?? up.error.status);
      }
      const { data, error, status } = await sb.from('lore_characters').update({ photo_path: path }).eq('id', id).select(CHARACTER_COLUMNS).maybeSingle();
      if (error || !data) {
        if (path) await sb.storage.from(PHOTOS_BUCKET).remove([path]);
        return error ? failFrom(error, status) : fail('NOT_FOUND', 'Personagem não encontrado.');
      }
      if (c.photo_path) await sb.storage.from(PHOTOS_BUCKET).remove([c.photo_path]);
      await loadNames();
      return ok(presentCharacter(data, await photoUrls([data])));
    },

    async addCharacterNote(characterId, input = {}) {
      const { error: g } = await guard('lore.anotacoes');
      if (g) return g;
      const next = { about: String(input.about ?? ''), body: String(input.body ?? '').trim() };
      const { valid, errors } = validateCharacterNote(next);
      if (!valid) return validation(errors);
      const { data, error, status } = await sb.from('character_admin_notes').insert({ character_id: characterId, ...next }).select('*').maybeSingle();
      if (error) return error.code === '23503' ? fail('NOT_FOUND', 'Personagem não encontrado.') : failFrom(error, status);
      await loadNames();
      return ok({ ...data, created_by_name: nameOf(data.created_by) });
    },

    async deleteCharacterNote(id) {
      const { error: g } = await guard('lore.anotacoes');
      if (g) return g;
      const { data, error, status } = await sb.from('character_admin_notes').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Anotação não encontrada.');
    },

    /* ----- Livro de Regras (15_regras.sql) ----- */
    async listRules() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('regras.ler') && !can('regras.editar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('rules').select(RULE_COLUMNS)
        .order('category').order('position').order('title');
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentRule));
    },

    async saveRule(input = {}) {
      const { error: g } = await guard('regras.editar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('rules').select(RULE_COLUMNS).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Regra não encontrada.');
        current = data;
      }
      const next = { position: 0, ...(current ? pickRule(current) : {}), ...pickRule(input) };
      const { valid, errors } = validateRule(next);
      if (!valid) return validation(errors);
      const q = current ? sb.from('rules').update(next).eq('id', current.id) : sb.from('rules').insert(next);
      const { data, error, status } = await q.select(RULE_COLUMNS).maybeSingle();
      if (error) return fieldFail(error, status, { [RULE_ERRORS.duplicate]: 'title' });
      if (!data) return fail('NOT_FOUND', 'Regra não encontrada.');
      await loadNames();
      return ok(presentRule(data));
    },

    async deleteRule(id) {
      const { error: g } = await guard('regras.editar');
      if (g) return g;
      const { data, error, status } = await sb.from('rules').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Regra não encontrada.');
    },

    /* ----- Agenda de Reuniões (17_agenda.sql) ----- */
    async listMeetings() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('agenda.ler') && !can('agenda.gerenciar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('meetings').select(MEETING_COLUMNS).order('starts_at').order('title');
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentMeeting));
    },

    async saveMeeting(input = {}) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('meetings').select(MEETING_COLUMNS).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Reunião não encontrada.');
        current = presentMeeting(data);
      }
      const next = { participants: [], ...(current ? pickMeeting(current) : {}), ...pickMeeting(input) };
      const { valid, errors } = validateMeeting(next);
      if (!valid) return validation(errors);
      // Uma transação só no banco (save_meeting): reunião e convocados juntos; conflito de horário não grava nada.
      const { data: id, error, status } = await sb.rpc('save_meeting', {
        p_id: current?.id ?? null, p_title: next.title, p_description: next.description ?? null,
        p_starts_at: new Date(next.starts_at).toISOString(), p_discord_link: next.discord_link ?? null, p_participants: next.participants,
      });
      if (error) {
        if (error.code === 'KB422' && String(error.message).startsWith(CONFLICT_PREFIX)) return validation({ starts_at: error.message });
        return error.code === 'KB404' ? fail('NOT_FOUND', 'Reunião não encontrada.') : failFrom(error, status);
      }
      const row = { id };
      const { data, error: e2, status: s2 } = await sb.from('meetings').select(MEETING_COLUMNS).eq('id', row.id).maybeSingle();
      if (e2) return failFrom(e2, s2);
      await loadNames();
      return ok(presentMeeting(data));
    },

    async checkMeetingConflict(input = {}) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      const next = pickMeeting(input);
      if (!next.starts_at || Number.isNaN(Date.parse(next.starts_at))) return ok(null);
      const { data, error, status } = await sb.rpc('check_meeting_conflict', {
        p_id: input.id ?? null, p_starts_at: new Date(next.starts_at).toISOString(), p_participants: next.participants ?? [],
      });
      if (error) return failFrom(error, status);
      return ok(data ?? null);
    },

    async deleteMeeting(id) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.from('meetings').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Reunião não encontrada.');
    },

    /* ----- Perfil da staff (20_perfil.sql) ----- */
    async getProfile(discordId) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('perfil_obter', { p_discord_id: String(discordId) });
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', PROFILE_ERRORS.notFound);
      return ok(data);
    },

    async listProfileHistory(discordId, { limit = 20, offset = 0 } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('perfil_historico', { p_discord_id: String(discordId), p_limit: limit, p_offset: offset });
      if (error) return failFrom(error, status);
      return ok({ items: data?.items ?? [], total: Number(data?.total ?? 0) });
    },

    async updateMyProfile(patch = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const next = pickProfileEdit(patch);
      const { valid, errors } = validateProfileEdit(next);
      if (!valid) return validation(errors);
      const { error, status } = await sb.rpc('perfil_atualizar', {
        p_bio: 'bio' in next ? next.bio : null,
        p_banner_color: 'banner_color' in next ? next.banner_color : null,
        p_perfil_publico: 'perfil_publico' in next ? next.perfil_publico : null,
      });
      return error ? failFrom(error, status) : ok(null);
    },

    async syncMyAvatar(url) {
      const { error: g } = await guard();
      if (g) return g;
      const clean = safeAvatar(url);
      if (!clean) return validation({ _: PROFILE_ERRORS.avatar });
      const { error, status } = await sb.rpc('perfil_sincronizar_avatar', { p_url: clean });
      return error ? failFrom(error, status) : ok(null);
    },

    /* ----- Painel da Diretoria (21_diretoria.sql) ----- */
    async getDiretoriaMembers() {
      const { error: g } = await guard('diretoria.ver');
      if (g) return g;
      const { data, error, status } = await sb.rpc('diretoria_membros');
      if (error) return failFrom(error, status);
      return ok((data ?? []).map((m) => ({
        ...m, teams: [...(m.teams ?? [])], areas: m.areas ?? [], media: m.media == null ? null : Number(m.media),
        avaliacoes: Number(m.avaliacoes ?? 0), ocorrencias: Number(m.ocorrencias ?? 0),
      })));
    },

    async listDirectorEvaluations() {
      const { error: g } = await guard('diretoria.ver');
      if (g) return g;
      const { data, error, status } = await sb.from('diretoria_avaliacoes').select('*').order('criado_em', { ascending: false });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentDirectorEvaluation));
    },

    async saveDirectorEvaluation(input) {
      const { staff, error: g } = await guard('diretoria.ver');
      if (g) return g;
      const next = pickDirectorEvaluation(input);
      // A regra de alvo (cargo e situação do avaliado) é do banco; aqui só os campos.
      const errors = validateDirectorEvaluation(staff, { discord_id: next.avaliado_id, role: 'allowlist', active: true }, next);
      if (next.avaliado_id !== staff.discord_id) delete errors.avaliado_id;
      if (Object.keys(errors).length) return validation(errors);
      const args = {
        p_avaliado_id: next.avaliado_id, p_periodo_inicio: next.periodo_inicio, p_periodo_fim: next.periodo_fim,
        p_nota_geral: next.nota_geral, p_nota_presenca: next.nota_presenca, p_nota_qualidade: next.nota_qualidade,
        p_nota_colaboracao: next.nota_colaboracao, p_nota_iniciativa: next.nota_iniciativa,
        p_comentario: next.comentario || null, p_visivel_avaliado: next.visivel_avaliado,
      };
      // Plano 11: com o SQL 22 grava também a área e o "mostrar o comentário"; sem ele, a função do 21 (banco antigo).
      const withArea = (staff.features ?? []).includes('avaliacoes_area');
      const { data: id, error, status } = withArea
        ? await sb.rpc('registrar_avaliacao_area', { ...args, p_area_id: next.area_id, p_comentario_visivel: next.comentario_visivel })
        : await sb.rpc('registrar_avaliacao', args);
      if (error) return fieldFail(error, status, DIRETORIA_FIELDS);
      const { data, error: e2, status: s2 } = await sb.from('diretoria_avaliacoes').select('*').eq('id', id).single();
      if (e2) return failFrom(e2, s2);
      await loadNames();
      return ok(presentDirectorEvaluation(data));
    },

    async listOccurrences() {
      const { error: g } = await guard('diretoria.ver');
      if (g) return g;
      const { data, error, status } = await sb.from('diretoria_ocorrencias').select('*').order('feito_em', { ascending: false });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentOccurrence));
    },

    async saveOccurrence(input = {}) {
      const { staff, error: g } = await guard('diretoria.ver');
      if (g) return g;
      const next = { membro_id: String(input?.membro_id ?? '').trim(), tipo: String(input?.tipo ?? ''), descricao: String(input?.descricao ?? '').trim() };
      const errors = validateOccurrence(staff, { discord_id: next.membro_id, role: 'allowlist', active: true }, next);
      if (next.membro_id !== staff.discord_id) delete errors.membro_id;
      if (Object.keys(errors).length) return validation(errors);
      const { data: id, error, status } = await sb.rpc('registrar_ocorrencia', { p_membro_id: next.membro_id, p_tipo: next.tipo, p_descricao: next.descricao });
      if (error) return fieldFail(error, status, DIRETORIA_FIELDS);
      const { data, error: e2, status: s2 } = await sb.from('diretoria_ocorrencias').select('*').eq('id', id).single();
      if (e2) return failFrom(e2, s2);
      await loadNames();
      return ok(presentOccurrence(data));
    },

    async listRoleHistory({ memberId = '', limit = 25, offset = 0 } = {}) {
      const { error: g } = await guard('diretoria.ver');
      if (g) return g;
      const size = Math.max(1, Math.min(Number(limit) || 25, 100));
      const from = Math.max(0, Number(offset) || 0);
      let q = sb.from('diretoria_historico_cargos').select('*', { count: 'exact' });
      if (memberId) q = q.eq('membro_id', memberId);
      const { data, error, status, count } = await q.order('feito_em', { ascending: false }).order('id', { ascending: false }).range(from, from + size - 1);
      if (error) return failFrom(error, status);
      await loadNames();
      return ok({
        items: data.map((x) => ({ ...x, feito_em: new Date(x.feito_em).toISOString(), membro_nome: nameOf(x.membro_id), feito_por_nome: nameOf(x.feito_por) })),
        total: count ?? data.length,
      });
    },

    async changeMemberRole(discordId, role, motivo = '') {
      const { error: g } = await guard('equipe.gerenciar');
      if (g) return g;
      const why = reasonError(motivo);
      if (why) return validation({ motivo: why });
      const { error, status } = await sb.rpc('alterar_cargo_membro', { p_membro_id: String(discordId), p_cargo_novo: role, p_motivo: String(motivo ?? '').trim() || null });
      if (error) return fieldFail(error, status, DIRETORIA_FIELDS);
      const { data, error: e2, status: s2 } = await sb.from('staff_members').select(STAFF_COLUMNS).eq('discord_id', String(discordId)).maybeSingle();
      if (e2) return failFrom(e2, s2);
      return data ? ok(withTeams(data)) : fail('NOT_FOUND', DIRETORIA_ERRORS.member);
    },

    async getDiretoriaActivity({ from, to } = {}) {
      const { error: g } = await guard('diretoria.ver');
      if (g) return g;
      if (!from || !to || !(Date.parse(to) > Date.parse(from))) return validation({ _: DIRETORIA_ERRORS.period400 });
      const { data, error, status } = await sb.rpc('diretoria_atividades', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() });
      if (error) return failFrom(error, status);
      return ok((data ?? []).map((r) => ({ ...r, total: Number(r.total) })));
    },

    async getPromotionRules() {
      const { error: g } = await guard('diretoria.ver');
      if (g) return g;
      const { data, error, status } = await sb.from('diretoria_textos').select('conteudo, atualizado_por, atualizado_em').eq('chave', 'regras_promocao').maybeSingle();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok({ conteudo: data?.conteudo ?? '', atualizado_por: data?.atualizado_por ?? null, atualizado_por_nome: nameOf(data?.atualizado_por), atualizado_em: data?.atualizado_em ?? null });
    },

    async savePromotionRules(conteudo) {
      const { error: g } = await guard('diretoria.gerenciar');
      if (g) return g;
      const text = String(conteudo ?? '');
      const e = promotionRulesError(text);
      if (e) return validation({ conteudo: e });
      const { data, error, status } = await sb.from('diretoria_textos').update({ conteudo: text }).eq('chave', 'regras_promocao')
        .select('conteudo, atualizado_por, atualizado_em');
      if (error) return fieldFail(error, status, DIRETORIA_FIELDS);
      if (!data?.length) return fail('FORBIDDEN');
      await loadNames();
      return ok({ ...data[0], atualizado_por_nome: nameOf(data[0].atualizado_por) });
    },

    async getDirectorScore(discordId) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('perfil_nota_diretoria', { p_discord_id: String(discordId) });
      if (error) return failFrom(error, status);
      return ok(data ? { media: Number(data.media), total: Number(data.total) } : null);
    },

    /* ----- Plano 11: avaliações por área, no perfil e alinhamentos (22_diretoria_avaliacoes_alinhamento.sql) ----- */
    async getEvaluationsByArea({ days = 0 } = {}) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('diretoria.ver') && !can('diretoria.avaliacoes')) return fail('FORBIDDEN', AREA_EVAL_ERRORS.byAreaForbidden);
      const n = Number(days) || 0;
      const { data, error, status } = await sb.rpc('diretoria_avaliacoes_por_area', { p_desde: n > 0 ? new Date(Date.now() - n * 86400_000).toISOString() : null });
      if (error) return failFrom(error, status);
      const num = (v) => (v == null ? null : Number(v));
      return ok((data ?? []).map((r) => ({
        ...r, avaliados: Number(r.avaliados ?? 0), avaliacoes: Number(r.avaliacoes ?? 0),
        ...Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, num(r[f.key])])),
      })));
    },

    async listReceivedEvaluations(discordId) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('perfil_avaliacoes_recebidas', { p_discord_id: String(discordId) });
      if (error) return failFrom(error, status);
      if (data == null) return ok(null);
      return ok(data.map((e) => ({
        ...e, criado_em: new Date(e.criado_em).toISOString(),
        ...Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, Number(e[f.key])])),
      })));
    },

    async callAlignment(input = {}) {
      const { staff, can, error: g } = await guard('alinhamento.chamar');
      if (g) return g;
      const a = {
        membro_id: String(input.membro_id ?? '').trim(), mensagem: String(input.mensagem ?? '').trim(), prazo: String(input.prazo ?? ''),
        canal_id: String(input.canal_id ?? '').trim(), link_call: String(input.link_call ?? '').trim(), reuniao_em: String(input.reuniao_em ?? '').trim(),
      };
      const check = validateAlignment(a, { selfId: staff.discord_id });
      if (!check.valid) return validation(check.errors);
      let meetingId = null;
      if (a.reuniao_em) {
        if (!can('agenda.gerenciar')) return validation({ reuniao_em: ALIGNMENT_ERRORS.noAgenda });
        await loadNames();
        const created = await adapter.saveMeeting(alignmentMeetingInput({
          membroId: a.membro_id, membroNome: nameOf(a.membro_id), selfId: staff.discord_id, mensagem: a.mensagem, reuniaoEm: a.reuniao_em, linkCall: a.link_call,
        }));
        if (created.error) {
          const errs = created.error.details?.errors;
          return errs ? validation({ reuniao_em: errs.starts_at ?? errs._ ?? Object.values(errs)[0] }) : created;
        }
        meetingId = created.data.id;
      }
      const res = await invokeSend({
        action: 'alinhamento', membro_id: a.membro_id, mensagem: a.mensagem, prazo: a.prazo,
        canal_id: a.canal_id || null, link_call: a.link_call || null, reuniao_id: meetingId,
      });
      if (res.error) {
        // Nada foi enviado: a reunião criada para este alinhamento sai da Agenda.
        if (meetingId) await adapter.deleteMeeting(meetingId);
        if (res.error.message === 'Ação desconhecida.') return fail('NETWORK', ALIGNMENT_ERRORS.outdatedFunction);
      }
      return res;
    },

    async listAlignments({ limit = 20, offset = 0 } = {}) {
      const { error: g } = await guard('alinhamento.chamar');
      if (g) return g;
      const size = Math.max(1, Math.min(Number(limit) || 20, 100));
      const from = Math.max(0, Number(offset) || 0);
      const { data, error, status, count } = await sb.from('alinhamentos').select('*', { count: 'exact' })
        .order('criado_em', { ascending: false }).range(from, from + size - 1);
      if (error) return failFrom(error, status);
      await loadNames();
      return ok({
        items: data.map((x) => ({ ...x, criado_em: new Date(x.criado_em).toISOString(), membro_nome: nameOf(x.membro_id) ?? x.membro_nome, chamado_por_nome: nameOf(x.chamado_por) })),
        total: count ?? data.length,
      });
    },

    /* ----- Áreas da Staff (19_areas.sql) ----- */
    async listMyAreas() {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('minhas_areas');
      if (error) return failFrom(error, status);
      return ok(data.map((a) => ({ ...a, membros: Number(a.membros), procedimentos: Number(a.procedimentos) })));
    },

    async getArea(slug) {
      const { staff, error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('areas').select(AREA_COLUMNS).eq('slug', String(slug)).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', AREA_ERRORS.notFound);
      return ok({ ...data, papel: await myAreaRole(data.id, staff.discord_id) });
    },

    async listEligibleAreas() {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('listar_areas_elegiveis');
      return error ? failFrom(error, status) : ok(data);
    },

    async joinArea(areaId) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.rpc('entrar_na_area', { p_area: areaId });
      return error ? failFrom(error, status) : ok(null);
    },

    async leaveArea(areaId) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.rpc('sair_da_area', { p_area: areaId });
      return error ? failFrom(error, status) : ok(null);
    },

    async listAreaTeam(areaId) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('equipe_da_area', { p_area: areaId });
      return error ? failFrom(error, status) : ok(data);
    },

    async listAreaTags(areaId) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('areas_tags').select(AREA_TAG_COLUMNS).eq('area_id', areaId).order('nome');
      return error ? failFrom(error, status) : ok(data);
    },

    async listAreaProcedures(areaId) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('areas_procedimentos').select(AREA_PROCEDURE_COLUMNS).eq('area_id', areaId)
        .order('atualizado_em', { ascending: false });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentAreaProcedure));
    },

    async saveAreaProcedure(areaId, input = {}) {
      const { staff, can, error: g } = await guard();
      if (g) return g;
      const { data: area, error: e0, status: s0 } = await sb.from('areas').select('id, status').eq('id', areaId).maybeSingle();
      if (e0) return failFrom(e0, s0);
      if (!area) return fail('FORBIDDEN');
      let row = null;
      if (input.id) {
        const { data, error, status } = await sb.from('areas_procedimentos').select(AREA_PROCEDURE_COLUMNS).eq('id', input.id).eq('area_id', areaId).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        row = data;
      }
      const papel = await myAreaRole(areaId, staff.discord_id);
      const access = areaProcedureAccess({ papel, manager: can('areas.gerenciar'), authorId: row?.criado_por ?? null, myId: staff.discord_id });
      if (row ? !access.edit : !access.create) return fail('FORBIDDEN');
      if (area.status !== 'ativa') return validation({ _: AREA_ERRORS.archivedArea });
      const next = { titulo: '', conteudo: '', status: 'publicado', tags: [], ...(row ? pickAreaProcedure(row) : {}), ...pickAreaProcedure(input) };
      const { valid, errors } = validateAreaProcedure(next);
      if (!valid) return validation(errors);
      const table = sb.from('areas_procedimentos');
      const { data, error, status } = row
        ? await table.update(next).eq('id', row.id).select(AREA_PROCEDURE_COLUMNS).maybeSingle()
        : await table.insert({ ...next, area_id: areaId }).select(AREA_PROCEDURE_COLUMNS).single();
      if (error) return failFrom(error, status);
      if (!data) return fail('FORBIDDEN');
      await loadNames();
      return ok(presentAreaProcedure(data));
    },

    async deleteAreaProcedure(id) {
      const { error: g } = await guard();
      if (g) return g;
      const found = await sb.from('areas_procedimentos').select('id').eq('id', id).maybeSingle();
      if (found.error) return failFrom(found.error, found.status);
      if (!found.data) return fail('NOT_FOUND', 'Procedimento não encontrado.');
      const { data, error, status } = await sb.from('areas_procedimentos').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('FORBIDDEN');
    },

    async listAreaHistory(areaId, { limit = 20, offset = 0 } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status, count } = await sb.from('areas_historico').select(AREA_HISTORY_COLUMNS, { count: 'exact' })
        .eq('area_id', areaId).order('id', { ascending: false }).range(offset, offset + limit - 1);
      if (error) return failFrom(error, status);
      await loadNames();
      return ok({ items: data.map((e) => ({ ...e, ator_nome: nameOf(e.ator_id) })), total: count ?? data.length });
    },

    /* ----- Áreas da Staff: painel de gestão (areas.gerenciar) ----- */
    async listAreas() {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      const [areas, members, procs] = await Promise.all([
        sb.from('areas').select(AREA_COLUMNS).order('ordem').order('nome'),
        sb.from('areas_membros').select('area_id'),
        sb.from('areas_procedimentos').select('area_id').neq('status', 'arquivado'),
      ]);
      for (const r of [areas, members, procs]) if (r.error) return failFrom(r.error, r.status);
      const count = (rows, id) => rows.data.filter((x) => x.area_id === id).length;
      return ok(areas.data.map((a) => ({ ...a, papel: null, membros: count(members, a.id), procedimentos: count(procs, a.id) })));
    },

    async saveArea(input = {}) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      let row = null;
      if (input.id) {
        const found = await sb.from('areas').select(AREA_COLUMNS).eq('id', input.id).maybeSingle();
        if (found.error) return failFrom(found.error, found.status);
        if (!found.data) return fail('NOT_FOUND', 'Área não encontrada.');
        row = found.data;
      }
      const all = await sb.from('areas').select('slug, ordem');
      if (all.error) return failFrom(all.error, all.status);
      const picked = pickArea(input);
      const slug = row ? row.slug : (picked.slug || areaSlug(picked.nome ?? '', all.data.map((a) => a.slug)));
      const next = {
        descricao: null, icone: null, cor: DEFAULT_AREA_COLOR, nivel_minimo: 1, status: 'ativa', discord_role_id: null, discord_canal_id: null,
        ordem: Math.max(0, ...all.data.map((a) => a.ordem)) + 1, ...(row ? pickArea(row) : {}), ...picked, slug,
      };
      const { valid, errors } = validateArea(next);
      if (!valid) return validation(errors);
      const table = sb.from('areas');
      const { slug: _slug, ...changes } = next;
      const { data, error, status } = row
        ? await table.update(changes).eq('id', row.id).select(AREA_COLUMNS).maybeSingle()
        : await table.insert(next).select(AREA_COLUMNS).single();
      if (error) return error.code === '23505' ? validation({ slug: AREA_MANAGE_ERRORS.slugTaken }) : failFrom(error, status);
      return data ? ok({ ...data, papel: null }) : fail('FORBIDDEN');
    },

    async reorderAreas(ids = []) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      for (const [i, id] of ids.entries()) {
        const { error, status } = await sb.from('areas').update({ ordem: i + 1 }).eq('id', id).neq('ordem', i + 1);
        if (error) return failFrom(error, status);
      }
      return ok(null);
    },

    async deleteArea(id) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.from('areas').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Área não encontrada.');
    },

    async addAreaMember(areaId, discordId, papel = 'membro') {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      if (!AREA_ROLES.includes(papel)) return validation({ papel: AREA_MANAGE_ERRORS.role });
      if (!AREA_DISCORD_ID.test(String(discordId))) return validation({ discord_id: AREA_MANAGE_ERRORS.member });
      const { error, status } = await sb.from('areas_membros').insert({ area_id: areaId, discord_id: discordId, papel });
      if (error?.code === '23505') return validation({ _: AREA_MANAGE_ERRORS.alreadyMember });
      if (error?.code === '23503') return validation({ discord_id: AREA_MANAGE_ERRORS.member });
      return error ? failFrom(error, status) : ok(null);
    },

    async setAreaMemberRole(areaId, discordId, papel) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      if (!AREA_ROLES.includes(papel)) return validation({ papel: AREA_MANAGE_ERRORS.role });
      const { data, error, status } = await sb.from('areas_membros').update({ papel }).eq('area_id', areaId).eq('discord_id', discordId).select('discord_id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Membro não encontrado nesta área.');
    },

    async removeAreaMember(areaId, discordId) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.from('areas_membros').delete().eq('area_id', areaId).eq('discord_id', discordId).select('discord_id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Membro não encontrado nesta área.');
    },

    async listMembersWithoutArea() {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.rpc('membros_sem_area');
      return error ? failFrom(error, status) : ok(data);
    },

    async saveAreaTag(areaId, input = {}) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      let row = null;
      if (input.id) {
        const found = await sb.from('areas_tags').select(AREA_TAG_COLUMNS).eq('id', input.id).eq('area_id', areaId).maybeSingle();
        if (found.error) return failFrom(found.error, found.status);
        if (!found.data) return fail('NOT_FOUND', 'Tag não encontrada.');
        row = found.data;
      }
      const next = { nome: '', cor: DEFAULT_TAG_COLOR, discord_role_id: null, ...(row ? pickAreaTag(row) : {}), ...pickAreaTag(input) };
      const { valid, errors } = validateAreaTag(next);
      if (!valid) return validation(errors);
      const table = sb.from('areas_tags');
      const { data, error, status } = row
        ? await table.update(next).eq('id', row.id).select(AREA_TAG_COLUMNS).maybeSingle()
        : await table.insert({ ...next, area_id: areaId }).select(AREA_TAG_COLUMNS).single();
      if (error) return error.code === '23505' ? validation({ nome: AREA_MANAGE_ERRORS.tagTaken }) : failFrom(error, status);
      return data ? ok(data) : fail('FORBIDDEN');
    },

    async deleteAreaTag(id) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      // O banco recusa procedimento com tag que não existe mais: tira a tag deles antes de apagar.
      const used = await sb.from('areas_procedimentos').select('id, tags').contains('tags', [id]);
      if (used.error) return failFrom(used.error, used.status);
      for (const p of used.data) {
        const { error, status } = await sb.from('areas_procedimentos').update({ tags: p.tags.filter((t) => t !== id) }).eq('id', p.id);
        if (error) return error.code === 'KB422' ? validation({ _: error.message }) : failFrom(error, status);
      }
      const { data, error, status } = await sb.from('areas_tags').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Tag não encontrada.');
    },

    async listAllAreaHistory({ areaId = '', actorId = '', acao = '', from = '', to = '', limit = 20, offset = 0 } = {}) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      const { start, end } = historyRange({ from, to });
      let q = sb.from('areas_historico').select(AREA_HISTORY_COLUMNS, { count: 'exact' });
      if (areaId) q = q.eq('area_id', areaId);
      if (actorId) q = q.eq('ator_id', actorId);
      if (acao) q = q.eq('acao', acao);
      if (start) q = q.gte('criado_em', start);
      if (end) q = q.lt('criado_em', end);
      const { data, error, status, count } = await q.order('id', { ascending: false }).range(offset, offset + limit - 1);
      if (error) return failFrom(error, status);
      await loadNames();
      return ok({ items: data.map((e) => ({ ...e, ator_nome: nameOf(e.ator_id) })), total: count ?? data.length });
    },

    async listAreaMessages(areaId = '', { limit = 20, offset = 0 } = {}) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      let q = sb.from('areas_comunicacoes').select(AREA_MESSAGE_COLUMNS, { count: 'exact' });
      if (areaId) q = q.eq('area_id', areaId);
      const { data, error, status, count } = await q.order('criado_em', { ascending: false }).range(offset, offset + limit - 1);
      if (error) return failFrom(error, status);
      await loadNames();
      return ok({ items: data.map((c) => ({ ...c, enviado_por_nome: nameOf(c.enviado_por) })), total: count ?? data.length });
    },

    /* ----- Áreas: mensagens no Discord pela Edge Function (ação 'area'; plano 07, Fase 4) ----- */
    async sendAreaMessage(areaId, { tipo, conteudo, canal_id = '', user_ids = [], mencionar_cargo = false, link_call = '' } = {}) {
      const { error: g } = await guard('areas.gerenciar');
      if (g) return g;
      const check = validateAreaMessage({ kind: tipo, conteudo, canal_id, user_ids, link_call });
      if (!check.valid) return validation(check.errors);
      const res = await invokeSend({
        action: 'area', kind: tipo, area_id: areaId, conteudo, canal_id: String(canal_id).trim() || null, user_ids,
        mencionar_cargo: mencionar_cargo === true, link_call: String(link_call).trim() || null,
      });
      // A função antiga (antes das Áreas) não conhece a ação 'area'.
      if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', AREA_DISCORD_ERRORS.outdatedFunction);
      return res;
    },

    /* ----- Botões da Agenda: status (18_agenda_status.sql) e avisos no Discord (Edge Function, ação 'reuniao') ----- */
    async startMeeting(id) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      const moved = await moveMeeting(id, 'agendada', 'em_andamento', MEETING_STATUS_ERRORS.notStarted);
      if (moved.error) return moved;
      // O status já mudou: se o aviso no privado falhar, a reunião continua iniciada e a tela mostra o motivo.
      const sent = await sendMeetingMessage(id, 'inicio');
      return ok({ meeting: moved.data, dm: sent.error ? null : sent.data?.dm ?? null, dm_error: sent.error ? (sent.error.details?.errors?._ ?? sent.error.message) : null });
    },

    async endMeeting(id) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      return moveMeeting(id, 'em_andamento', 'concluida', MEETING_STATUS_ERRORS.notRunning);
    },

    async announceMeeting(id, { webhookId = null } = {}) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      return sendMeetingMessage(id, 'anuncio', webhookId);
    },

    async notifyMeeting(id) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      return sendMeetingMessage(id, 'convocacao');
    },

    /* ----- Etapa 10: produtividade (13_produtividade.sql) ----- */
    async getProductivity({ from, to } = {}) {
      const { error: g } = await guard('produtividade.ver');
      if (g) return g;
      if (!from || !to || !(Date.parse(to) > Date.parse(from))) return validation({ _: PRODUCTIVITY_ERRORS.period });
      const { data, error, status } = await sb.rpc('staff_productivity', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() });
      if (error) return failFrom(error, status);
      const iso = (m) => ({ ...m, last_at: m.last_at ? new Date(m.last_at).toISOString() : null });
      const byName = (a, b) => (a.display_name ?? a.discord_id).localeCompare(b.display_name ?? b.discord_id, 'pt-BR');
      return ok({
        totals: data.totals, daily: data.daily,
        members: data.members.map(iso).sort(byName), inactive: data.inactive.map(iso).sort(byName),
      });
    },

    /* ----- Entrevistas: escala, agenda e registro (24_escalas.sql) ----- */
    async getEscalaConfig() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!escCanRead(can)) return fail('FORBIDDEN');
      return escReadConfig();
    },

    async saveEscalaConfig(input = {}) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const current = await escReadConfig();
      if (current.error) return current;
      const next = { ...current.data, ...pickEscalaConfig(input) };
      const { valid, errors } = validateEscalaConfig(next);
      if (!valid) return validation(errors);
      const blank = (v) => (String(v ?? '').trim() === '' ? null : String(v).trim());
      const { error, status } = await sb.from('entrevistas_configuracao').update({
        dias_semana: next.dias_semana, horarios: next.horarios, antecedencia_aviso_minutos: next.antecedencia_aviso_minutos,
        canal_discord_escala: blank(next.canal_discord_escala), canal_discord_registros: blank(next.canal_discord_registros),
        canal_discord_avisos: blank(next.canal_discord_avisos), cargo_discord_entrevistador: blank(next.cargo_discord_entrevistador),
        cargo_discord_suporte: blank(next.cargo_discord_suporte), mensagem_link_call: next.mensagem_link_call, mensagem_cargo_id: next.mensagem_cargo_id,
      }).eq('id', 1);
      if (error) return failFrom(error, status);
      return escReadConfig();
    },

    async getEscala(id) {
      const { staff, can, error: g } = await guard();
      if (g) return g;
      if (!escCanRead(can)) return fail('FORBIDDEN');
      const query = sb.from('escalas').select('*');
      const { data: escala, error, status } = id ? await query.eq('id', id).maybeSingle() : await query.neq('status', 'encerrada').maybeSingle();
      if (error) return failFrom(error, status);
      if (!escala) return id ? fail('NOT_FOUND', ESCALA_ERRORS.noEscala) : ok({ escala: null, slots: [], minha_disponibilidade: [], respondi: false });
      // Sempre filtra pelo próprio Discord ID: a Direção enxerga a disponibilidade de todos (lição 2).
      const [slots, mine, answered] = await Promise.all([
        sb.from('escalas_slots').select('id, dia_semana, horario, discord_id, funcao, realocado_por, realocado_em').eq('escala_id', escala.id),
        sb.from('escalas_disponibilidade').select('dia_semana, horario').eq('escala_id', escala.id).eq('discord_id', staff.discord_id),
        sb.from('escalas_respostas').select('discord_id').eq('escala_id', escala.id).eq('discord_id', staff.discord_id),
        loadNames(),
      ]);
      for (const r of [slots, mine, answered]) if (r.error) return failFrom(r.error, r.status);
      return ok({
        escala,
        slots: slots.data.map((s) => ({ ...s, display_name: nameOf(s.discord_id) })),
        minha_disponibilidade: mine.data,
        respondi: answered.data.length > 0,
      });
    },

    async listEscalas() {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const [list, slots, sessions] = await Promise.all([
        sb.from('escalas').select('*').order('periodo_inicio', { ascending: false }),
        sb.from('escalas_slots').select('escala_id'),
        sb.from('entrevistas_sessoes').select('escala_id'),
      ]);
      for (const r of [list, slots, sessions]) if (r.error) return failFrom(r.error, r.status);
      const count = (rows, id) => rows.filter((r) => r.escala_id === id).length;
      return ok(list.data.map((e) => ({ ...e, slots_total: count(slots.data, e.id), sessoes_total: count(sessions.data, e.id) })));
    },

    async openEscala(input = {}) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const { valid, errors } = validateOpenEscala(input);
      if (!valid) return validation(errors);
      const { data: id, error, status } = await sb.rpc('abrir_escala', {
        p_inicio: input.periodo_inicio, p_fim: input.periodo_fim, p_encerramento: new Date(input.encerramento).toISOString(),
      });
      if (error) return failFrom(error, status);
      const { data, error: e2, status: s2 } = await sb.from('escalas').select('*').eq('id', id).maybeSingle();
      return e2 ? failFrom(e2, s2) : ok(data);
    },

    async getAvailabilitySummary(escalaId) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.rpc('get_disponibilidade_resumo', { p_escala: escalaId });
      if (error) return failFrom(error, status);
      return ok({ membros: data?.membros ?? [], celulas: data?.celulas ?? [] });
    },

    async saveMyAvailability(escalaId, slots = []) {
      const { error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      const cfg = await escReadConfig();
      if (cfg.error) return cfg;
      const { valid, errors } = validateAvailability(slots, cfg.data);
      if (!valid) return validation(errors);
      const { data, error, status } = await sb.rpc('registrar_disponibilidade', {
        p_escala: escalaId, p_slots: slots.map(({ dia_semana, horario }) => ({ dia_semana, horario })),
      });
      return error ? failFrom(error, status) : ok({ total: data ?? 0 });
    },

    async closeAvailability(escalaId) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const { error, status } = await sb.rpc('fechar_disponibilidade', { p_escala: escalaId });
      if (error) return failFrom(error, status);
      const { data, error: e2, status: s2 } = await sb.from('escalas').select('*').eq('id', escalaId).maybeSingle();
      return e2 ? failFrom(e2, s2) : ok(data);
    },

    async saveEscalaSlots(escalaId, slots = []) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const { valid, errors } = validateSlots(slots);
      if (!valid) return validation(errors);
      const { data, error, status } = await sb.rpc('salvar_slots', {
        p_escala: escalaId, p_slots: slots.map(({ dia_semana, horario, discord_id, funcao }) => ({ dia_semana, horario, discord_id, funcao })),
      });
      return error ? failFrom(error, status) : ok({ total: data ?? 0 });
    },

    async publishEscala(escalaId) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const { data: created, error, status } = await sb.rpc('publicar_escala', { p_escala: escalaId });
      if (error) return failFrom(error, status);
      // Publicada no banco: a falha do Discord não desfaz, só avisa.
      const sent = await invokeSend({ action: 'publicar_escala_discord', escala_id: escalaId });
      const { data: escala } = await sb.from('escalas').select('*').eq('id', escalaId).maybeSingle();
      return ok({ escala, sessoes: created ?? 0, discord_error: sent.error ? escDiscordError(sent.error) : null });
    },

    async sendEscalaToDiscord(escalaId) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const res = await invokeSend({ action: 'publicar_escala_discord', escala_id: escalaId });
      if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', ESC_DISCORD_ERRORS.outdatedFunction);
      return res;
    },

    async endEscala(escalaId, reason) {
      const { staff, error: g } = await guard();
      if (g) return g;
      // Banco sem o SQL 25: a função antiga (sem motivo e sem auditoria própria).
      if (!staff.features.includes('apagar')) {
        if (!staff.permissions.includes('escalas.gerenciar')) return fail('FORBIDDEN');
        const { error, status } = await sb.rpc('encerrar_escala', { p_escala: escalaId });
        return error ? failFrom(error, status) : ok(null);
      }
      const res = await destroy('escalas.cancelar', 'fechar_escala', { p_escala: escalaId }, reason);
      return res.error ? res : ok(null);
    },

    async reallocateSlot(slotId, novoId) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const { error, status } = await sb.rpc('realocar_slot', { p_slot: slotId, p_novo: String(novoId) });
      return error ? failFrom(error, status) : ok(null);
    },

    async listInterviewSessions({ from, to } = {}) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!escCanRead(can)) return fail('FORBIDDEN');
      const { data, error, status } = await sb.rpc('get_agenda', { p_inicio: from ?? '2000-01-01', p_fim: to ?? '2100-12-31' });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok((data ?? []).map(escPresentSession));
    },

    async getInterviewSession(id) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!escCanRead(can)) return fail('FORBIDDEN');
      const [ses, people, reg, hist] = await Promise.all([
        sb.from('entrevistas_sessoes').select('*').eq('id', id).maybeSingle(),
        sb.from('entrevistas_participantes').select('discord_id, funcao, substituindo_id, presente').eq('sessao_id', id).order('adicionado_em'),
        sb.from('entrevistas_registros').select('*').eq('sessao_id', id).maybeSingle(),
        sb.from('escalas_historico').select('id, tipo, referencia_id, discord_id, dados_anteriores, dados_novos, criado_em').eq('referencia_id', id).order('id', { ascending: false }),
        loadNames(),
      ]);
      for (const r of [ses, people, reg, hist]) if (r.error) return failFrom(r.error, r.status);
      if (!ses.data) return fail('NOT_FOUND', ESCALA_ERRORS.noSession);
      return ok({
        ...escPresentSession({ ...ses.data, tem_registro: Boolean(reg.data), participantes: people.data }),
        registro: reg.data ? { ...reg.data, registrado_por_nome: nameOf(reg.data.registrado_por) } : null,
        historico: hist.data.map((h) => ({ ...h, autor_nome: nameOf(h.discord_id) })),
      });
    },

    async setInterviewSessionStatus(id, status) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status: code } = await sb.rpc('alterar_status_sessao', { p_sessao: id, p_status: status });
      if (error) return failFrom(error, code);
      return adapter.getInterviewSession(id);
    },

    async registerSubstitution(sessaoId, input = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const { valid, errors } = validateSubstitution(input);
      if (!valid) return validation(errors);
      const { error, status } = await sb.rpc('registrar_substituicao', {
        p_sessao: sessaoId, p_original: input.original, p_substituto: input.substituto, p_motivo: String(input.motivo ?? '').trim() || null,
      });
      return error ? failFrom(error, status) : adapter.getInterviewSession(sessaoId);
    },

    async registerAbsence(sessaoId, discordId) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.rpc('registrar_ausencia', { p_sessao: sessaoId, p_discord_id: String(discordId) });
      return error ? failFrom(error, status) : adapter.getInterviewSession(sessaoId);
    },

    async registerInterview(sessaoId, input = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const print = input.print ?? null;
      const { valid, errors } = validateRegistro({ ...input, tem_print: Boolean(print) });
      if (!valid) return validation(errors);
      const file = validatePrintFile(print);
      if (!file.valid) return validation({ print: file.error });
      const path = `${sessaoId}/${globalThis.crypto.randomUUID()}.${print.type.split('/')[1].replace('jpeg', 'jpg')}`;
      const up = await sb.storage.from(ESC_PRINTS_BUCKET).upload(path, print.blob ?? print, { contentType: print.type, upsert: false });
      if (up.error) return failFrom(up.error, up.error.statusCode ?? up.error.status);
      const { data: id, error, status } = await sb.rpc('registrar_sessao', {
        p_sessao: sessaoId, p_total: Number(input.total_entrevistados), p_obs: String(input.observacoes ?? '').trim() || null, p_print_path: path,
        p_participantes: (input.participantes ?? []).map((p) => ({ discord_id: p.discord_id, funcao: p.funcao, presente: p.presente !== false, substituindo_id: p.substituindo_id || '' })),
      });
      if (error) {
        // Nada foi registrado: o arquivo enviado não fica órfão.
        await sb.storage.from(ESC_PRINTS_BUCKET).remove([path]);
        return failFrom(error, status);
      }
      const sent = await invokeSend({ action: 'enviar_registro_discord', sessao_id: sessaoId });
      const { data: registro } = await sb.from('entrevistas_registros').select('*').eq('id', id).maybeSingle();
      return ok({ registro, discord_error: sent.error ? escDiscordError(sent.error) : null });
    },

    async editInterviewRegistro(sessaoId, input = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const { valid, errors } = validateRegistroEdit(input);
      if (!valid) return validation(errors);
      let path = null;
      if (input.print) {
        const file = validatePrintFile(input.print);
        if (!file.valid) return validation({ print: file.error });
        path = `${sessaoId}/${globalThis.crypto.randomUUID()}.${input.print.type.split('/')[1].replace('jpeg', 'jpg')}`;
        const up = await sb.storage.from(ESC_PRINTS_BUCKET).upload(path, input.print.blob ?? input.print, { contentType: input.print.type, upsert: false });
        if (up.error) return failFrom(up.error, up.error.statusCode ?? up.error.status);
      }
      const { error, status } = await sb.rpc('editar_registro', {
        p_sessao: sessaoId, p_total: Number(input.total_entrevistados), p_obs: String(input.observacoes ?? '').trim() || null, p_print_path: path,
      });
      if (error) {
        if (path) await sb.storage.from(ESC_PRINTS_BUCKET).remove([path]);
        return failFrom(error, status);
      }
      const { data, error: e2, status: s2 } = await sb.from('entrevistas_registros').select('*').eq('sessao_id', sessaoId).maybeSingle();
      return e2 ? failFrom(e2, s2) : ok(data);
    },

    async getInterviewPrintUrl(sessaoId) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!escCanRead(can)) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('entrevistas_registros').select('print_call_path').eq('sessao_id', sessaoId).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', ESCALA_ERRORS.noRegistro);
      const signed = await sb.storage.from(ESC_PRINTS_BUCKET).createSignedUrl(data.print_call_path, 3600);
      if (signed.error) return failFrom(signed.error, signed.error.statusCode ?? signed.error.status);
      return ok(signed.data?.signedUrl ?? null);
    },

    async sendInterviewRegistro(sessaoId, { resend = false } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const res = await invokeSend({ action: 'enviar_registro_discord', sessao_id: sessaoId, resend });
      if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', ESC_DISCORD_ERRORS.outdatedFunction);
      return res;
    },

    async sendInterviewNotice(sessaoId) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const res = await invokeSend({ action: 'enviar_aviso_entrevista', sessao_id: sessaoId });
      if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', ESC_DISCORD_ERRORS.outdatedFunction);
      return res;
    },

    /* ----- Documento 14: apagar, remover, cancelar e redefinir com auditoria (25_apagar_auditoria.sql) ----- */
    async deleteCharacter(id, reason) {
      const res = await destroy('personagens.apagar', 'apagar_personagem', { p_id: id }, reason);
      return res.error ? res : ok(null);
    },

    async cancelInterviewSession(id, reason) {
      const { staff, error: g } = await guard();
      if (g) return g;
      // Banco sem o SQL 25: a troca de estado antiga (só a Direção, sem motivo e sem aviso).
      if (!staff.features.includes('apagar')) {
        if (!staff.permissions.includes('escalas.gerenciar')) return fail('FORBIDDEN');
        const old = await adapter.setInterviewSessionStatus(id, 'cancelada');
        return old.error ? old : ok({ session: old.data, dm: null, discord_error: null });
      }
      const res = await destroy('escalas.cancelar', 'cancelar_sessao_agendada', { p_sessao: id }, reason);
      if (res.error) return res;
      // A sessão já está cancelada no banco; o aviso no privado é um extra e a falha dele só vira um recado.
      const sent = await invokeSend({ action: 'avisar_cancelamento_entrevista', sessao_id: id, motivo: validateReason(reason).reason });
      const detail = await adapter.getInterviewSession(id);
      return ok({
        session: detail.error ? null : detail.data,
        dm: sent.error ? null : sent.data?.dm ?? null,
        discord_error: sent.error ? escDiscordError(sent.error) : null,
      });
    },

    async resetEscalaConfig(reason) {
      const res = await destroy('escalas.redefinir', 'redefinir_configuracao_entrevistas', {}, reason);
      return res.error ? res : escReadConfig();
    },

    async eraseEvaluation(id, reason) {
      const res = await destroy('avaliacoes.apagar', 'apagar_avaliacao', { p_id: id }, reason);
      return res.error ? res : ok(null);
    },

    async deleteOccurrence(id, reason) {
      const res = await destroy('ocorrencias.apagar', 'apagar_ocorrencia', { p_id: id }, reason);
      return res.error ? res : ok(null);
    },

    async cancelAlignment(id, reason) {
      const res = await destroy('alinhamentos.apagar', 'cancelar_alinhamento', { p_id: id }, reason);
      return res.error ? res : ok(null);
    },

    async deleteInterviewQuestion(id, reason) {
      const res = await destroy('gabarito.apagar', 'apagar_pergunta', { p_id: id }, reason);
      return res.error ? res : ok(null);
    },

    async deleteChecklistItem(id, reason) {
      const res = await destroy('gabarito.apagar', 'apagar_item_checklist', { p_id: id }, reason);
      return res.error ? res : ok(null);
    },

    async listEscalaHistory({ limit = 100 } = {}) {
      const { error: g } = await guard('escalas.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.from('escalas_historico')
        .select('id, tipo, referencia_id, discord_id, dados_anteriores, dados_novos, criado_em').order('id', { ascending: false }).limit(Math.min(Number(limit) || 100, 500));
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map((h) => ({ ...h, autor_nome: nameOf(h.discord_id) })));
    },

    async listStaffNames() {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('staff_names');
      if (error) return failFrom(error, status);
      return ok(data.map((r) => ({ discord_id: r.discord_id, display_name: r.display_name }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR')));
    },

    /* ----- Etapa 7: envio ao Discord pela Edge Function (a url do webhook nunca vem ao site) ----- */
    async sendAlToDiscord(evaluationId, { webhookId, resend = false } = {}) {
      const { error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      return invokeSend({ action: 'enviar', evaluation_id: evaluationId, webhook_id: webhookId, resend: Boolean(resend) });
    },

    async sendAnnouncementToDiscord(announcementId, { webhookId = null, siteUrl = '', channel = true, dm = false } = {}) {
      const { error: g } = await guard('avisos.enviar');
      if (g) return g;
      const res = await invokeSend({ action: 'aviso', announcement_id: announcementId, webhook_id: webhookId, site_url: siteUrl, channel, dm });
      // A função antiga (antes da Decisão 11) não conhece a ação "aviso".
      if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', DISCORD_SEND_ERRORS.outdatedFunction);
      return res;
    },

    async listDiscordRoleIds() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('webhooks.gerenciar') && !can('avisos.enviar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('discord_role_ids').select('role, discord_role_id').order('role');
      return error ? failFrom(error, status) : ok(data);
    },

    async saveDiscordRoleIds(map = {}) {
      const { error: g } = await guard('webhooks.gerenciar');
      if (g) return g;
      const { valid, errors } = validateDiscordRoleIds(map);
      if (!valid) return fail('VALIDATION', Object.values(errors)[0], { errors });
      const entries = Object.entries(map).map(([role, id]) => [role, String(id ?? '').trim()]);
      const upserts = entries.filter(([, id]) => id).map(([role, discord_role_id]) => ({ role, discord_role_id }));
      const removes = entries.filter(([, id]) => !id).map(([role]) => role);
      if (upserts.length) {
        // Sem upsert: o ON CONFLICT DO UPDATE tentaria gravar a coluna "role", que o banco não libera (só discord_role_id).
        const existing = await sb.from('discord_role_ids').select('role');
        if (existing.error) return failFrom(existing.error, existing.status);
        const known = new Set(existing.data.map((r) => r.role));
        const inserts = upserts.filter((u) => !known.has(u.role));
        if (inserts.length) {
          const { error, status } = await sb.from('discord_role_ids').insert(inserts);
          if (error) return failFrom(error, status);
        }
        for (const { role, discord_role_id } of upserts.filter((u) => known.has(u.role))) {
          const { error, status } = await sb.from('discord_role_ids').update({ discord_role_id }).eq('role', role);
          if (error) return failFrom(error, status);
        }
      }
      if (removes.length) {
        const { error, status } = await sb.from('discord_role_ids').delete().in('role', removes);
        if (error) return failFrom(error, status);
      }
      return adapter.listDiscordRoleIds();
    },

    async testDiscordWebhook(webhookId) {
      const { error: g } = await guard('webhooks.gerenciar');
      if (g) return g;
      return invokeSend({ action: 'testar', webhook_id: webhookId });
    },
  };

  /**
   * Chama a Edge Function enviar-discord. Ela responde { data, error } no formato do contrato;
   * 404 da própria função = ainda não instalada no Supabase.
   */
  async function invokeSend(body) {
    const { data, error } = await sb.functions.invoke(FUNCTION_NAME, { body });
    if (!error) return data?.error ? fail(data.error.code, data.error.message, data.error.details) : ok(data?.data ?? null);
    const response = error.context;
    // Sem resposta legível: função não instalada (o Supabase responde 404 sem CORS) ou rede.
    if (typeof response?.json !== 'function') return fail('NETWORK', DISCORD_SEND_ERRORS.unreachable);
    const payload = await response.json().catch(() => null);
    if (payload?.error?.code) return fail(payload.error.code, payload.error.message, payload.error.details);
    if (response.status === 404) return fail('NETWORK', DISCORD_SEND_ERRORS.missingFunction);
    return failFrom({ message: payload?.message ?? error.message }, response.status);
  }

  /**
   * Documento 14 · chama a função do banco que apaga, cancela ou redefine. O banco confere a permissão e grava a auditoria
   * (quem, cargo, quando, o que existia antes e o motivo); aqui só a resposta rápida e a tradução do erro.
   */
  async function destroy(permission, fn, args, reason) {
    const { staff, error: g } = await guard(permission);
    if (g) return g;
    if (!staff.features.includes('apagar')) return fail('NETWORK', APAGAR_ERRORS.notInstalled);
    const check = validateReason(reason);
    if (!check.valid) return validation({ _: check.error });
    const { data, error, status } = await sb.rpc(fn, { ...args, p_motivo: check.reason });
    return error ? failFrom(error, status) : ok(data ?? null);
  }

  /** Muda o status só se a reunião está no estado esperado (from); o banco também só deixa andar para a frente. */
  async function moveMeeting(id, from, to, wrongState) {
    const { data, error, status } = await sb.from('meetings').update({ status: to }).eq('id', id).eq('status', from).select(MEETING_COLUMNS);
    if (error) {
      if (error.code === '42703') return validation({ _: MEETING_STATUS_ERRORS.noStatus });
      return error.code === 'KB422' ? validation({ _: error.message }) : failFrom(error, status);
    }
    if (!data?.length) {
      const { data: row, error: e2, status: s2 } = await sb.from('meetings').select('id').eq('id', id).maybeSingle();
      if (e2) return failFrom(e2, s2);
      return row ? validation({ _: wrongState }) : fail('NOT_FOUND', 'Reunião não encontrada.');
    }
    await loadNames();
    return ok(presentMeeting(data[0]));
  }

  /* ---------- entrevistas: escala e registro ---------- */
  const escCanRead = (can) => can('allowlist.avaliar') || can('escalas.gerenciar');
  const escPresentSession = (s) => {
    const out = { ...s, participantes: (s.participantes ?? []).map((p) => ({ ...p, display_name: nameOf(p.discord_id) })) };
    return { ...out, view: sessionView(out, new Date()) };
  };
  /** Falha do Discord vira texto simples (a função antiga ainda não conhece as ações das entrevistas). */
  const escDiscordError = (error) => (error.message === 'Ação desconhecida.' ? ESC_DISCORD_ERRORS.outdatedFunction : error.details?.errors?._ ?? error.message);
  async function escReadConfig() {
    const { data, error, status } = await sb.from('entrevistas_configuracao').select('*').eq('id', 1).maybeSingle();
    if (error) return failFrom(error, status);
    const row = data ?? {};
    return ok({
      ...structuredClone(DEFAULT_ESCALA_CONFIG), ...row,
      canal_discord_escala: row.canal_discord_escala ?? '', canal_discord_registros: row.canal_discord_registros ?? '', canal_discord_avisos: row.canal_discord_avisos ?? '',
      cargo_discord_entrevistador: row.cargo_discord_entrevistador ?? '', cargo_discord_suporte: row.cargo_discord_suporte ?? '',
    });
  }

  /** Avisos da reunião pela Edge Function: kind 'anuncio' (canal), 'convocacao' ou 'inicio' (privado). */
  async function sendMeetingMessage(id, kind, webhookId = null) {
    const res = await invokeSend({ action: 'reuniao', meeting_id: id, kind, webhook_id: webhookId });
    // A função antiga (antes dos botões da Agenda) não conhece a ação 'reuniao'.
    if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', DISCORD_SEND_ERRORS.outdatedFunction);
    return res;
  }

  /* ---------- Etapa 5: apoio da Allowlist ---------- */
  const usesAllowlist = (can) => can('allowlist.avaliar') || can('allowlist.historico') || can('lore.gerenciar');
  const presentAl = (e) => ({ ...e, eval_flags: e.eval_flags ?? [], checklist: e.checklist ?? [], created_by_name: nameOf(e.created_by) });
  const presentAttachment = ({ evaluation_id, ...a }) => a;

  async function fetchAl(id) {
    const { data, error, status } = await sb.from('al_evaluations').select('*').eq('id', id).maybeSingle();
    if (error) return { error: failFrom(error, status) };
    if (!data) return { error: fail('NOT_FOUND', 'Análise não encontrada.') };
    return { row: data };
  }

  async function alDetail(id) {
    const found = await fetchAl(id);
    if (found.error) return found.error;
    const [parts, answers, atts] = await Promise.all([
      sb.from('al_evaluation_participants').select('discord_id, role').eq('evaluation_id', id),
      sb.from('al_evaluation_answers').select('question_id, question_text, note, send_to_discord, position').eq('evaluation_id', id).order('position'),
      sb.from('al_attachments').select(ATTACHMENT_COLUMNS).eq('evaluation_id', id).order('position'),
      loadNames(),
    ]);
    for (const r of [parts, answers, atts]) if (r.error) return failFrom(r.error, r.status);
    return ok({
      ...presentAl(found.row),
      participants: parts.data.map((p) => ({ ...p, display_name: nameOf(p.discord_id) }))
        .sort((a, b) => (a.role === 'responsavel' ? -1 : b.role === 'responsavel' ? 1 : 0)),
      answers: answers.data,
      attachments: atts.data.map(presentAttachment),
    });
  }

  const seesEvaluations = (can) => can('avaliacoes.criar') || can('avaliacoes.ler') || can('avaliacoes.gerenciar');
  const presentProposal = (p) => ({ ...p, created_by_name: nameOf(p.created_by), reviewed_by_name: nameOf(p.reviewed_by) });
  const presentEvaluation = (e) => ({ justification: '', ...e, criteria: e.criteria ?? [], evaluated_name: nameOf(e.evaluated_id), evaluator_name: nameOf(e.evaluator_id) });

  async function readGrid() {
    const [perms, rows] = await Promise.all([
      sb.from('permissions').select('code, description, ceo_only, default_roles, sort_order').order('sort_order'),
      sb.from('role_permissions').select('role, permission, allowed'),
    ]);
    if (perms.error) return failFrom(perms.error, perms.status);
    if (rows.error) return failFrom(rows.error, rows.status);
    const grid = Object.fromEntries(ROLE_CODES.filter((r) => r !== CEO).map((r) => [r, {}]));
    for (const p of perms.data) for (const r of Object.keys(grid)) grid[r][p.code] = false;
    for (const row of rows.data) if (grid[row.role]) grid[row.role][row.permission] = row.allowed;
    return ok({
      permissions: perms.data.map((p) => ({
        code: p.code, description: p.description, ceo_only: p.ceo_only, default_roles: [...(p.default_roles ?? [])],
      })),
      grid,
    });
  }

  return adapter;
}
