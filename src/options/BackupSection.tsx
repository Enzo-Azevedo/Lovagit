import { useCallback, useRef, useState } from 'react';
import { backupFileName, createBackup, restoreBackup } from '../lib/backup/store';
import { MIN_PASSWORD_LENGTH } from '../lib/backup/envelope';

const inputClass =
  'w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-200 outline-none placeholder:text-ink-600 focus:border-ink-600';
const primaryButton =
  'rounded-md bg-gradient-to-r from-lov-orange to-lov-pink px-3 py-1.5 text-xs font-medium text-lov-ink disabled:opacity-40';
const ghostButton = 'rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200';

/**
 * Exportar e importar tudo num arquivo cifrado.
 *
 * O navegador apaga os dados da extensao quando ela e' desinstalada, e nao ha
 * API que sobreviva a isso. Este arquivo e' o unico jeito de atravessar uma
 * reinstalacao — e como ele carrega o PAT e as chaves de API, sai cifrado com
 * uma senha em vez de texto puro.
 */
export function BackupSection() {
  const [exportPassword, setExportPassword] = useState('');
  const [exportConfirm, setExportConfirm] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const senhaCurta = exportPassword.length < MIN_PASSWORD_LENGTH;
  const senhasDiferem = exportPassword !== exportConfirm;

  const exportar = useCallback(async () => {
    setBusy(true);
    setErro(null);
    setMessage(null);
    try {
      const envelope = await createBackup(exportPassword);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = backupFileName();
      link.click();
      URL.revokeObjectURL(url);
      setExportPassword('');
      setExportConfirm('');
      setMessage('Backup gerado. Guarde o arquivo E a senha — sem ela, ele nao abre.');
    } catch (caught) {
      setErro(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [exportPassword]);

  const importar = useCallback(async () => {
    if (!arquivo) return;
    setBusy(true);
    setErro(null);
    setMessage(null);
    try {
      const envelope = JSON.parse(await arquivo.text()) as unknown;
      const resumo = await restoreBackup(envelope, importPassword);
      setImportPassword('');
      setArquivo(null);
      if (fileRef.current) fileRef.current.value = '';
      setMessage(
        `Restaurado da versao ${resumo.fromVersion}: ${resumo.keys} item(ns) e ` +
          `${resumo.secrets} credencial(is). Recarregue esta pagina para ver.`,
      );
    } catch (caught) {
      setErro(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [arquivo, importPassword]);

  return (
    <section
      id="backup"
      className="glass space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4"
    >
      <h2 className="text-sm text-ink-200">8. Backup das configuracoes</h2>
      <p className="text-[11px] text-ink-400">
        Ao desinstalar a extensao, o navegador apaga tudo — configuracoes, conversas, memoria e
        cofre. Nao ha API que sobreviva a isso: para o Chrome, os dados sao da extensao, nao seus.
        Este arquivo e' a unica travessia.
      </p>
      <p className="text-[11px] text-ink-400">
        Para trocar de versao voce <strong>nao precisa desinstalar</strong>: substitua o conteudo da
        pasta e clique em recarregar (⟳) em <code>chrome://extensions</code>. Nada se perde. O
        backup e' para o resto — perfil recriado, pasta movida, maquina nova.
      </p>

      <div className="space-y-2 rounded-md border border-ink-700 bg-ink-950 p-3">
        <p className="text-xs text-ink-200">Exportar</p>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="password"
            className={inputClass}
            value={exportPassword}
            placeholder={`Senha do arquivo (min. ${MIN_PASSWORD_LENGTH})`}
            onChange={(event) => setExportPassword(event.target.value)}
          />
          <input
            type="password"
            className={inputClass}
            value={exportConfirm}
            placeholder="Repita a senha"
            onChange={(event) => setExportConfirm(event.target.value)}
          />
        </div>
        <button
          className={primaryButton}
          disabled={busy || senhaCurta || senhasDiferem}
          onClick={() => void exportar()}
        >
          {busy ? 'Gerando...' : 'Gerar backup'}
        </button>
        <p className="text-[10px] text-ink-400">
          Leva o PAT do GitHub, as chaves de API, os tokens dos servidores MCP, as conversas, a
          memoria e os checkpoints. Fica de fora o que e' cache (o mapa dos repositorios se refaz
          sozinho) e o que esta em transito. A senha nao e' guardada em lugar nenhum:{' '}
          <strong>esquecendo, o arquivo nao abre</strong>.
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-ink-700 bg-ink-950 p-3">
        <p className="text-xs text-ink-200">Importar</p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="block w-full text-[11px] text-ink-400 file:mr-2 file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-xs file:text-ink-200"
          onChange={(event) => setArquivo(event.target.files?.[0] ?? null)}
        />
        <div className="flex gap-2">
          <input
            type="password"
            className={inputClass}
            value={importPassword}
            placeholder="Senha do arquivo"
            onChange={(event) => setImportPassword(event.target.value)}
          />
          <button
            className={ghostButton}
            disabled={busy || !arquivo || !importPassword}
            onClick={() => void importar()}
          >
            {busy ? 'Restaurando...' : 'Restaurar'}
          </button>
        </div>
        <p className="text-[10px] text-ink-400">
          Restaurar substitui o que o backup traz e deixa o resto em paz — um repositorio conectado
          depois do backup continua aqui.
        </p>
      </div>

      {message && (
        <p className="rounded-md border border-lov-orange/30 bg-lov-orange/10 px-3 py-2 text-[11px] text-ink-200">
          {message}
        </p>
      )}
      {erro && (
        <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {erro}
        </p>
      )}
    </section>
  );
}
