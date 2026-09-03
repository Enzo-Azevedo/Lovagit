import { useCallback, useEffect, useState } from 'react';
import {
  fetchLatestBuild,
  formatBytes,
  installedVersion,
  isNewerBuild,
  openDownload,
  type LatestBuild,
} from '../lib/github/releases';
import { Button } from './ui';

/**
 * Versao instalada e link para o ultimo build da `main`.
 *
 * O MV3 proibe codigo remoto, entao nao ha como a extensao se atualizar
 * sozinha fora da Chrome Web Store: o maximo honesto e' dizer o que existe
 * publicado e abrir o download numa guia. Quem instala e' voce.
 */
export function UpdateBar() {
  const [build, setBuild] = useState<LatestBuild | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);
  const instalada = installedVersion();

  const buscar = useCallback(async (force: boolean) => {
    setBuscando(true);
    setErro(null);
    try {
      setBuild(await fetchLatestBuild({ force }));
    } catch (caught) {
      setErro(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBuscando(false);
    }
  }, []);

  useEffect(() => {
    void buscar(false);
  }, [buscar]);

  const novidade = build !== null && isNewerBuild(build, instalada);

  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[10px] ${
        novidade
          ? 'border-lov-orange/30 bg-lov-orange/10 text-lov-orange'
          : 'border-ink-700/60 text-ink-400'
      }`}
    >
      <span className="font-mono">v{instalada}</span>

      {build && (
        <>
          <span className="truncate text-ink-400">
            {novidade ? `novo build: v${build.version}` : 'build da main'}
            {build.commit && ` · ${build.commit}`}
          </span>
          <Button
            className="ml-auto"
            variant={novidade ? 'primary' : 'ghost'}
            title={`${build.name} · ${formatBytes(build.sizeBytes)} · publicado em ${new Date(
              build.publishedAt,
            ).toLocaleString('pt-BR')}`}
            onClick={() => void openDownload(build.downloadUrl)}
          >
            Baixar zip
          </Button>
        </>
      )}

      {!build && (
        <Button
          className="ml-auto"
          variant="ghost"
          disabled={buscando}
          onClick={() => void buscar(true)}
        >
          {buscando ? 'Procurando...' : erro ? 'Tentar de novo' : 'Procurar build'}
        </Button>
      )}

      {erro && !build && (
        <span className="truncate text-ink-400" title={erro}>
          sem resposta do GitHub
        </span>
      )}
    </div>
  );
}
