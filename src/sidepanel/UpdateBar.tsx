import { useCallback, useEffect, useState } from 'react';
import {
  buildStatus,
  CACHE_KEY,
  fetchLatestBuild,
  formatBytes,
  installedVersion,
  openDownload,
  type BuildStatus,
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

/** Aparencia da faixa e do botao para cada situacao do build publicado. */
const APARENCIA: Record<
  BuildStatus,
  {
    faixa: string;
    botao: 'primary' | 'success' | 'ghost';
    rotulo: string;
    /** `true` quando nao ha nada a fazer: o botao vira selo. */
    inerte: boolean;
    descricao: (build: LatestBuild) => string;
  }
> = {
  nova: {
    faixa: 'border-lov-orange/30 bg-lov-orange/10 text-lov-orange',
    botao: 'primary',
    rotulo: 'Baixar zip',
    inerte: false,
    descricao: (build) => `novo build: v${build.version}`,
  },
  atual: {
    faixa: 'border-emerald-500/25 text-emerald-300',
    botao: 'success',
    rotulo: 'Versao atualizada',
    inerte: true,
    descricao: () => 'voce esta na ultima versao publicada',
  },
  desconhecida: {
    faixa: 'border-ink-700/60 text-ink-400',
    botao: 'ghost',
    rotulo: 'Baixar zip',
    inerte: false,
    descricao: () => 'build da main',
  },
};

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

  // O service worker procura build novo a cada 30 minutos, inclusive com o
  // painel aberto. Sem escutar a chave do cache, essa procura so apareceria aqui
  // no proximo reload — e quem deixa o painel aberto o dia todo nunca veria.
  useEffect(() => {
    const aoMudar = (
      mudancas: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'local') return;
      const novo = mudancas[CACHE_KEY]?.newValue as LatestBuild | undefined;
      if (novo) {
        setBuild(novo);
        setErro(null);
      }
    };
    chrome.storage.onChanged.addListener(aoMudar);
    return () => chrome.storage.onChanged.removeListener(aoMudar);
  }, []);

  const situacao = build === null ? null : buildStatus(build, instalada);
  const aparencia = situacao === null ? null : APARENCIA[situacao];

  return (
    <div
      className={`glass flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[10px] ${
        aparencia?.faixa ?? 'border-ink-700/60 text-ink-400'
      }`}
    >
      <span className="font-mono">v{instalada}</span>

      {build && aparencia && (
        <>
          <span className="truncate text-ink-400">
            {aparencia.descricao(build)}
            {build.commit && ` · ${build.commit}`}
          </span>
          <Button
            className="ml-auto"
            variant={aparencia.botao}
            disabled={aparencia.inerte}
            title={
              aparencia.inerte
                ? 'Nada a baixar: o build publicado tem a mesma versao desta instalacao'
                : `${build.name} · ${formatBytes(build.sizeBytes)} · publicado em ${new Date(
                    build.publishedAt,
                  ).toLocaleString('pt-BR')}`
            }
            onClick={aparencia.inerte ? undefined : () => void openDownload(build.downloadUrl)}
          >
            {aparencia.rotulo}
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
