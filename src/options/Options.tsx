import { useCallback, useEffect, useState } from 'react';
import { getAuthenticatedUser } from '../lib/github/client';
import { getSettings, saveSettings } from '../lib/storage';
import { deleteSecret, getSecret, hasSecret, SecretNames, setSecret } from '../lib/vault';
import { PROVIDER_PRESETS, providerFromPreset } from '../lib/ai/presets';
import { validateProviderKey, type ValidationResult } from '../lib/ai/validate';
import { providerOrigin } from '../lib/ai/registry';
import { getRedirectUri, getStoredTokens, loginWithOAuth, logoutOAuth } from '../lib/ai/oauth';
import { installErrorHandlers } from '../lib/telemetry/reporter';
import type { ProviderConfig, Settings } from '../lib/types';
import { McpSection } from './McpSection';
import { TelemetrySection } from './TelemetrySection';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-ink-200">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-ink-400">{hint}</span>}
    </label>
  );
}

const inputClass =
  'w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-200 outline-none placeholder:text-ink-600 focus:border-ink-600';

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pat, setPat] = useState('');
  const [patSaved, setPatSaved] = useState(false);
  const [patStatus, setPatStatus] = useState<string | null>(null);
  // Separa "ja existe chave salva" (booleano) do rascunho digitado agora. Guardar
  // os dois no mesmo mapa faria o placeholder da chave salva ser gravado como chave.
  const [hasProviderKey, setHasProviderKey] = useState<Record<string, boolean>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [validations, setValidations] = useState<Record<string, ValidationResult>>({});
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [oauthStatus, setOauthStatus] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const loaded = await getSettings();
    setSettings(loaded);
    setPatSaved(await hasSecret(SecretNames.githubPat));
    const keys: Record<string, boolean> = {};
    const oauth: Record<string, string> = {};
    for (const provider of loaded.providers) {
      if (provider.kind === 'oauth') {
        const tokens = await getStoredTokens(provider.id);
        oauth[provider.id] = tokens ? 'conectado' : 'desconectado';
      } else {
        keys[provider.id] = Boolean(await getSecret(SecretNames.providerApiKey(provider.id)));
      }
    }
    setHasProviderKey(keys);
    setOauthStatus(oauth);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => installErrorHandlers('options'), []);

  const saveToken = useCallback(async () => {
    const value = pat.trim();
    if (!value) return;
    await setSecret(SecretNames.githubPat, value);
    setPat('');
    try {
      const user = await getAuthenticatedUser();
      await saveSettings({ githubUser: { login: user.login, avatarUrl: user.avatarUrl } });
      setPatStatus(`Conectado como ${user.login}`);
    } catch (error) {
      setPatStatus(error instanceof Error ? error.message : String(error));
    }
    await reload();
  }, [pat, reload]);

  const removeToken = useCallback(async () => {
    await deleteSecret(SecretNames.githubPat);
    await saveSettings({ githubUser: null });
    setPatStatus(null);
    await reload();
  }, [reload]);

  const updateProvider = useCallback(
    async (id: string, patch: Partial<ProviderConfig>) => {
      if (!settings) return;
      const providers = settings.providers.map((provider) =>
        provider.id === id ? ({ ...provider, ...patch } as ProviderConfig) : provider,
      );
      setSettings({ ...settings, providers });
      await saveSettings({ providers });
    },
    [settings],
  );

  const addProvider = useCallback(
    async (presetKey: string) => {
      if (!settings) return;
      const preset = PROVIDER_PRESETS.find((item) => item.key === presetKey);
      if (!preset) return;
      const provider = providerFromPreset(preset);
      const providers = [...settings.providers, provider];
      await saveSettings({
        providers,
        activeProviderId: settings.activeProviderId ?? provider.id,
      });
      await reload();
    },
    [reload, settings],
  );

  const removeProvider = useCallback(
    async (id: string) => {
      if (!settings) return;
      const providers = settings.providers.filter((provider) => provider.id !== id);
      await deleteSecret(SecretNames.providerApiKey(id));
      await logoutOAuth(id);
      await saveSettings({
        providers,
        activeProviderId: settings.activeProviderId === id ? (providers[0]?.id ?? null) : settings.activeProviderId,
      });
      await reload();
    },
    [reload, settings],
  );

  /** Salva a chave e ja pede a permissao de host da origem do endpoint.
   *  `permissions.request` precisa do gesto do usuario — por isso vem primeiro. */
  const saveProviderKey = useCallback(
    async (provider: ProviderConfig, key: string) => {
      if (!key.trim()) {
        setMessage('Digite a chave antes de salvar.');
        return;
      }
      const origin = providerOrigin(provider);
      if (origin) {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          setMessage(`Sem permissao para acessar ${origin} — a extensao nao conseguira chamar a API.`);
          return;
        }
      }
      await setSecret(SecretNames.providerApiKey(provider.id), key.trim());
      setKeyDrafts((prev) => ({ ...prev, [provider.id]: '' }));
      setValidatingId(provider.id);
      // Valida na hora: descobrir que a chave esta errada so na primeira
      // mensagem do chat e o pior momento possivel.
      const result = await validateProviderKey(provider, key.trim());
      setValidations((prev) => ({ ...prev, [provider.id]: result }));
      setValidatingId(null);
      setMessage(`${provider.label}: ${result.message}`);
      await reload();
    },
    [reload],
  );

  const revalidate = useCallback(async (provider: ProviderConfig) => {
    const stored = await getSecret(SecretNames.providerApiKey(provider.id));
    if (!stored) {
      setMessage('Nenhuma chave salva para validar.');
      return;
    }
    setValidatingId(provider.id);
    const result = await validateProviderKey(provider, stored);
    setValidations((prev) => ({ ...prev, [provider.id]: result }));
    setValidatingId(null);
    setMessage(`${provider.label}: ${result.message}`);
  }, []);

  const doOAuthLogin = useCallback(
    async (provider: ProviderConfig) => {
      if (provider.kind !== 'oauth') return;
      const origin = providerOrigin(provider);
      if (origin) await chrome.permissions.request({ origins: [origin] });
      try {
        await loginWithOAuth(provider);
        setMessage(`Login em ${provider.label} concluido.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
      await reload();
    },
    [reload],
  );

  if (!settings) return <div className="p-6 text-xs text-ink-400">Carregando...</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <h1 className="text-base font-medium text-ink-200">Lovagit</h1>
        <p className="text-xs text-ink-400">
          Um chat de IA por repositorio do GitHub, com contexto isolado e commits protegidos por
          branch de backup.
        </p>
      </header>

      {message && (
        <p className="rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-xs text-ink-200">
          {message}
        </p>
      )}

      <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
        <h2 className="text-sm text-ink-200">1. GitHub</h2>
        {patSaved ? (
          <div className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-950 px-3 py-2">
            <span className="text-xs text-ink-200">
              Token salvo
              {settings.githubUser ? ` · ${settings.githubUser.login}` : ''}
            </span>
            <button className="text-xs text-red-300 hover:underline" onClick={() => void removeToken()}>
              Remover
            </button>
          </div>
        ) : (
          <Field
            label="Personal Access Token"
            hint="Fine-grained: permissoes Contents (read & write) e Metadata (read) nos repositorios desejados. Classico: escopo repo. O token e cifrado com AES-GCM antes de ir para o storage."
          >
            <div className="flex gap-2">
              <input
                type="password"
                value={pat}
                onChange={(event) => setPat(event.target.value)}
                placeholder="github_pat_..."
                className={inputClass}
              />
              <button
                className="rounded-md bg-lime-accent px-3 py-1.5 text-xs font-medium text-ink-950"
                onClick={() => void saveToken()}
              >
                Salvar
              </button>
            </div>
          </Field>
        )}
        {patStatus && <p className="text-[11px] text-ink-400">{patStatus}</p>}
      </section>

      <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm text-ink-200">2. Inteligencia artificial</h2>
          <select
            className={`${inputClass} w-auto`}
            value=""
            onChange={(event) => event.target.value && void addProvider(event.target.value)}
          >
            <option value="">+ Adicionar provedor</option>
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>

        {settings.providers.length === 0 && (
          <p className="text-xs text-ink-400">
            Nenhum provedor configurado. Adicione um acima — chave de API (BYOK) ou login OAuth.
          </p>
        )}

        {settings.providers.map((provider) => (
          <div key={provider.id} className="space-y-3 rounded-md border border-ink-700 bg-ink-950 p-3">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-ink-200">
                <input
                  type="radio"
                  name="active-provider"
                  checked={settings.activeProviderId === provider.id}
                  onChange={() => void saveSettings({ activeProviderId: provider.id }).then(reload)}
                />
                {provider.label}
                <span className="text-[10px] text-ink-400">({provider.kind})</span>
              </label>
              <button
                className="text-xs text-red-300 hover:underline"
                onClick={() => void removeProvider(provider.id)}
              >
                Remover
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Endpoint (base URL)">
                <input
                  className={inputClass}
                  value={provider.baseUrl}
                  placeholder="https://api.exemplo.com/v1"
                  onChange={(event) => void updateProvider(provider.id, { baseUrl: event.target.value })}
                />
              </Field>
              <Field
                label="Modelo"
                hint={
                  validations[provider.id]?.models.length
                    ? `${validations[provider.id].models.length} modelo(s) da sua conta sugeridos no campo`
                    : PROVIDER_PRESETS.find((preset) => preset.kind === provider.kind)?.modelHint
                }
              >
                <input
                  className={inputClass}
                  list={`models-${provider.id}`}
                  value={provider.model}
                  onChange={(event) => void updateProvider(provider.id, { model: event.target.value })}
                />
                <datalist id={`models-${provider.id}`}>
                  {(validations[provider.id]?.models ?? []).map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </Field>
            </div>

            {provider.kind === 'oauth' ? (
              <div className="space-y-3">
                <p className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[11px] text-ink-400">
                  Anthropic e OpenAI nao oferecem OAuth para acesso a API por terceiros — a
                  Anthropic restringe o fluxo ao Claude Code e ao claude.ai, e o login da OpenAI e
                  identidade, nao acesso a API. Para essas duas, use chave de API acima. Este bloco
                  serve para provedores que expoem OAuth para a propria API.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Authorization URL">
                    <input
                      className={inputClass}
                      value={provider.authorizationUrl}
                      onChange={(event) =>
                        void updateProvider(provider.id, { authorizationUrl: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Token URL">
                    <input
                      className={inputClass}
                      value={provider.tokenUrl}
                      onChange={(event) => void updateProvider(provider.id, { tokenUrl: event.target.value })}
                    />
                  </Field>
                  <Field label="Client ID">
                    <input
                      className={inputClass}
                      value={provider.clientId}
                      onChange={(event) => void updateProvider(provider.id, { clientId: event.target.value })}
                    />
                  </Field>
                  <Field label="Scopes (separados por espaco)">
                    <input
                      className={inputClass}
                      value={provider.scopes.join(' ')}
                      onChange={(event) =>
                        void updateProvider(provider.id, {
                          scopes: event.target.value.split(/\s+/).filter(Boolean),
                        })
                      }
                    />
                  </Field>
                </div>
                <Field
                  label="Redirect URI (registre esta URL no provedor)"
                  hint="A extensao usa OAuth 2.0 com PKCE e nao guarda client_secret — nao existe segredo seguro em codigo que roda no navegador."
                >
                  <input className={inputClass} readOnly value={getRedirectUri()} />
                </Field>
                <div className="flex items-center gap-2">
                  <button
                    className="rounded-md bg-lime-accent px-3 py-1.5 text-xs font-medium text-ink-950"
                    onClick={() => void doOAuthLogin(provider)}
                  >
                    Fazer login
                  </button>
                  <button
                    className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200"
                    onClick={() => void logoutOAuth(provider.id).then(reload)}
                  >
                    Sair
                  </button>
                  <span className="text-[11px] text-ink-400">
                    Status: {oauthStatus[provider.id] ?? 'desconectado'}
                  </span>
                </div>
              </div>
            ) : (
              <Field
                label="Chave de API"
                hint="Cifrada no cofre local. Nunca sai do navegador exceto para o proprio provedor."
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  {(() => {
                    const docsUrl = PROVIDER_PRESETS.find(
                      (preset) => preset.kind === provider.kind && preset.docsUrl,
                    )?.docsUrl;
                    return docsUrl ? (
                      <button
                        className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200"
                        onClick={() => void chrome.tabs.create({ url: docsUrl })}
                      >
                        Abrir painel de chaves
                      </button>
                    ) : null;
                  })()}
                  <button
                    className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200 disabled:opacity-40"
                    disabled={validatingId === provider.id}
                    onClick={() => void revalidate(provider)}
                  >
                    {validatingId === provider.id ? 'Validando...' : 'Testar chave salva'}
                  </button>
                  {validations[provider.id] && (
                    <span
                      className={`text-[11px] ${validations[provider.id].ok ? 'text-lime-accent' : 'text-red-300'}`}
                    >
                      {validations[provider.id].message}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    className={inputClass}
                    value={keyDrafts[provider.id] ?? ''}
                    placeholder={hasProviderKey[provider.id] ? 'chave salva — digite para substituir' : 'sk-...'}
                    onChange={(event) =>
                      setKeyDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))
                    }
                  />
                  <button
                    className="rounded-md bg-lime-accent px-3 py-1.5 text-xs font-medium text-ink-950 disabled:opacity-40"
                    disabled={!(keyDrafts[provider.id] ?? '').trim()}
                    onClick={() => void saveProviderKey(provider, keyDrafts[provider.id] ?? '')}
                  >
                    Salvar
                  </button>
                </div>
              </Field>
            )}
          </div>
        ))}
      </section>

      <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
        <h2 className="text-sm text-ink-200">3. Politica de commit</h2>
        <label className="flex items-start gap-2 text-xs text-ink-200">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={settings.autoApplyChanges}
            onChange={(event) => void saveSettings({ autoApplyChanges: event.target.checked }).then(reload)}
          />
          <span>
            Commitar automaticamente na branch padrao
            <span className="mt-1 block text-[11px] text-ink-400">
              Com a opcao ligada, a IA cria a branch de backup e commita sozinha ao terminar a
              alteracao. Desligada, as alteracoes ficam esperando seu clique em "Commitar" no chat.
              Em ambos os casos a branch de backup e criada antes do commit, e da para voltar pelo
              historico.
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
        <h2 className="text-sm text-ink-200">4. Falha passageira do provedor</h2>
        <label className="flex items-start gap-2 text-xs text-ink-200">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={settings.autoRetryOnFailure}
            onChange={(event) =>
              void saveSettings({ autoRetryOnFailure: event.target.checked }).then(reload)
            }
          />
          <span>
            Reenviar a mensagem automaticamente apos 5 segundos
            <span className="mt-1 block text-[11px] text-ink-400">
              Vale so para falha passageira — queda de conexao, 429 e erro 5xx do provedor, como o
              "Upstream idle timeout exceeded" do OpenRouter. Chave invalida, modelo inexistente e
              erro da extensao nao sao reenviados, porque a segunda tentativa daria no mesmo. O
              reenvio acontece uma vez por mensagem, da para cancelar durante a contagem, e nao
              acontece se o turno ja tiver commitado alguma coisa.
            </span>
          </span>
        </label>
      </section>

      <McpSection />

      <TelemetrySection />
    </div>
  );
}
