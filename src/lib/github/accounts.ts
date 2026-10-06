import { getAuthenticatedUser } from './client';
import { getSettings, saveSettings } from '../storage';
import { deleteSecret, SecretNames, setSecret } from '../vault';
import type { GitHubAccount } from '../types';

/**
 * Contas GitHub multi-token.
 *
 * O PAT de cada conta fica no cofre sob `github_pat:<id>`; a lista e a conta
 * ativa moram em `settings`. Estas funcoes sao o unico caminho de escrita — a
 * UI nunca mexe direto nas duas metades (cofre + settings), porque esquecer
 * uma delas deixa uma conta fantasma (lista sem token) ou um token orfao
 * (token sem lista).
 */

export async function addGitHubAccount(token: string): Promise<GitHubAccount> {
  const value = token.trim();
  if (!value) throw new Error('Informe o token.');

  // Valida o token recem-colado, nao o da conta ativa. Validar contra a conta
  // ativa e o defeito que fazia um token novo "nao pegar": a chamada usava o
  // token antigo e respondia com a conta errada (ou com Bad credentials).
  const user = await getAuthenticatedUser(value);

  const settings = await getSettings();
  const existing = settings.githubAccounts.find(
    (account) => account.login.toLowerCase() === user.login.toLowerCase(),
  );

  const account: GitHubAccount = {
    // Mesmo login = mesma conta: reusa o id para o token antigo nao virar um
    // orfao e a lista nao acumular duplicatas da mesma pessoa.
    id: existing?.id ?? crypto.randomUUID(),
    login: user.login,
    avatarUrl: user.avatarUrl,
  };

  await setSecret(SecretNames.githubPatAccount(account.id), value);
  // Token da era pre-multi-contas: depois que a conta entra na lista, o legado
  // so atrapalha. Se ficar, a resolucao ativa pode preferir a conta errada.
  await deleteSecret(SecretNames.githubPat);

  const accounts = existing
    ? settings.githubAccounts.map((item) => (item.id === existing.id ? account : item))
    : [...settings.githubAccounts, account];

  await saveSettings({
    githubAccounts: accounts,
    activeGitHubAccountId: account.id,
    githubUser: { login: account.login, avatarUrl: account.avatarUrl },
  });

  return account;
}

export async function removeGitHubAccount(accountId: string): Promise<void> {
  await deleteSecret(SecretNames.githubPatAccount(accountId));

  const settings = await getSettings();
  const accounts = settings.githubAccounts.filter((account) => account.id !== accountId);
  const activeId =
    settings.activeGitHubAccountId === accountId
      ? (accounts[0]?.id ?? null)
      : settings.activeGitHubAccountId;
  const active = accounts.find((account) => account.id === activeId) ?? accounts[0] ?? null;

  await saveSettings({
    githubAccounts: accounts,
    activeGitHubAccountId: activeId,
    githubUser: active ? { login: active.login, avatarUrl: active.avatarUrl } : null,
  });
}

export async function setActiveGitHubAccount(accountId: string): Promise<void> {
  const settings = await getSettings();
  const account = settings.githubAccounts.find((item) => item.id === accountId);
  if (!account) return;

  await saveSettings({
    activeGitHubAccountId: accountId,
    githubUser: { login: account.login, avatarUrl: account.avatarUrl },
  });
}
