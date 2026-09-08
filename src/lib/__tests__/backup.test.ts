import { describe, expect, it } from 'vitest';
import {
  BackupError,
  isEnvelope,
  MIN_PASSWORD_LENGTH,
  seal,
  unseal,
} from '../backup/envelope';
import { backupFileName, selectForBackup } from '../backup/store';

describe('envelope cifrado', () => {
  it('fecha e abre com a mesma senha', async () => {
    const dados = { storage: { settings: { providers: [] } }, secrets: { github_pat: 'ghp_x' } };
    const envelope = await seal(dados, 'senha-longa-o-bastante');

    await expect(unseal(envelope, 'senha-longa-o-bastante')).resolves.toEqual(dados);
  });

  it('o arquivo nao entrega o segredo a quem so o abre', async () => {
    // O backup fica parado numa pasta de Downloads ate a proxima instalacao.
    // Nesse tempo, o que esta escrito nele e' o que qualquer um le.
    const envelope = await seal({ secrets: { github_pat: 'ghp_supersecreto' } }, 'senha-boa-123');
    expect(JSON.stringify(envelope)).not.toContain('ghp_supersecreto');
    expect(JSON.stringify(envelope)).not.toContain('github_pat');
  });

  it('senha errada nao abre, e diz isso', async () => {
    const envelope = await seal({ a: 1 }, 'senha-certa-123');
    await expect(unseal(envelope, 'senha-errada-123')).rejects.toThrow(/senha incorreta/i);
  });

  it('recusa senha curta em vez de fingir que protegeu', async () => {
    await expect(seal({ a: 1 }, 'curta')).rejects.toBeInstanceOf(BackupError);
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });

  it('dois backups da mesma senha nao dao o mesmo arquivo', async () => {
    // Sal e IV aleatorios por backup: sem isso, arquivos iguais denunciariam
    // que o conteudo nao mudou, e reusar IV no AES-GCM quebra a cifra.
    const a = await seal({ x: 1 }, 'mesma-senha-aqui');
    const b = await seal({ x: 1 }, 'mesma-senha-aqui');
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it('arquivo adulterado nao passa', async () => {
    // AES-GCM autentica: mexer num byte do texto cifrado invalida a etiqueta.
    const envelope = await seal({ x: 1 }, 'senha-boa-1234');
    const trocado = envelope.data[0] === 'A' ? 'B' : 'A';
    const adulterado = { ...envelope, data: trocado + envelope.data.slice(1) };
    await expect(unseal(adulterado, 'senha-boa-1234')).rejects.toBeInstanceOf(BackupError);
  });

  it('arquivo qualquer nao e confundido com backup', async () => {
    expect(isEnvelope({ foo: 'bar' })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    await expect(unseal({ foo: 'bar' }, 'senha-boa-1234')).rejects.toThrow(/nao e um backup/i);
  });

  it('backup de formato futuro pede atualizacao em vez de quebrar torto', async () => {
    const envelope = { ...(await seal({ x: 1 }, 'senha-boa-1234')), version: 99 };
    await expect(unseal(envelope, 'senha-boa-1234')).rejects.toThrow(/versao mais nova/i);
  });
});

describe('o que entra no arquivo', () => {
  it('leva o que nao se refaz e descarta o que se refaz', () => {
    const selecionado = selectForBackup({
      settings: { providers: [] },
      'mcp:servers': [],
      'repo:acme/site:chat': [{ id: '1' }],
      'repo:acme/site:memory': [{ id: 'm1' }],
      'repo:acme/site:checkpoints': [{ commitSha: 'abc' }],
      'repo:acme/site:map': { entries: Array(5000) },
      'extension:latest-build': { version: '0.4.7' },
      'repo:acme/site:pending': { changes: [] },
      'telemetry:pending': {},
      'secret:github_pat': { iv: 'x', data: 'y' },
    });

    // O que o usuario construiu conversa a conversa.
    expect(Object.keys(selecionado)).toEqual(
      expect.arrayContaining([
        'settings',
        'mcp:servers',
        'repo:acme/site:chat',
        'repo:acme/site:memory',
        'repo:acme/site:checkpoints',
      ]),
    );

    // Cache: o mapa se refaz ao conectar, e e' o que mais pesaria no arquivo.
    expect(selecionado).not.toHaveProperty('repo:acme/site:map');
    expect(selecionado).not.toHaveProperty('extension:latest-build');

    // Em transito: restaurar turno pela metade ou fila de relatos antigos
    // produziria acao sem contexto na instalacao nova.
    expect(selecionado).not.toHaveProperty('repo:acme/site:pending');
    expect(selecionado).not.toHaveProperty('telemetry:pending');

    // O blob cifrado e' inutil sem a chave mestra, que fica para tras. O
    // conteudo viaja decifrado, dentro do envelope protegido por senha.
    expect(selecionado).not.toHaveProperty('secret:github_pat');
  });
});

describe('nome do arquivo', () => {
  it('traz a data, para varios backups conviverem na mesma pasta', () => {
    expect(backupFileName(new Date('2026-09-08T12:00:00Z'))).toBe('lovagit-backup-2026-09-08.json');
  });
});
