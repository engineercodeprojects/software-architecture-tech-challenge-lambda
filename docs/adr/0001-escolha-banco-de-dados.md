# ADR-0001 — Escolha do banco de dados: PostgreSQL no Amazon RDS

## Status

Aceito — 2026-09-06.

## Contexto

A Lambda de autenticação por CPF (`POST /auth` + Lambda Authorizer) precisa
localizar um cliente pelo CPF normalizado, verificar seu status e emitir um JWT.
Ela **não é dona** do dado: a tabela `cliente` pertence ao monolito NestJS da
Fase 2 (https://github.com/guilhermeqmaia/software-architecture-tech-challenge),
que já roda em PostgreSQL via Prisma e possui um domínio relacional (veículo,
ordem de serviço, itens, estoque, notificação) com chaves estrangeiras, enums
nativos e transações multi-tabela.

Estado atual do repositório:

- `README.md` declara "Banco: PostgreSQL (RDS)".
- `local/init.sql` reproduz a tabela `cliente` (`id UUID PK`, `nome`,
  `cpf_cnpj TEXT UNIQUE`, `email`, `telefone`, `ativo BOOLEAN`,
  `created_at`/`updated_at TIMESTAMPTZ`).
- `infra/terraform/main.tf` coloca a function na VPC do RDS (`subnet_ids`,
  `security_group_ids`), força `DB_SSL=true` e lê `DATABASE_URL` do AWS Secrets
  Manager.
- `src/infra/postgres-cliente.repository.ts` usa `pg.Pool` com `max: 1` e a
  query `WHERE regexp_replace("cpf_cnpj", '[^0-9]', '', 'g') = $1`.

Restrições: conta AWS Academy/Learner Lab (IAM limitado, orçamento baixo),
equipe pequena, necessidade de compartilhar exatamente os mesmos IDs de cliente
entre Lambda e aplicação (claim `sub`).

## Decisão

Usar **PostgreSQL gerenciado no Amazon RDS**, na **mesma instância/base do
monolito Fase 2**, acessado pela Lambda:

- de dentro da VPC, em subnets privadas, com security group liberando apenas a
  porta do RDS;
- com TLS obrigatório (`DB_SSL=true`);
- com credenciais em Secrets Manager (`DB_SECRET_ID` → `DATABASE_URL`), idealmente
  um usuário somente leitura (`GRANT SELECT ON cliente`);
- com pool de **1 conexão por container** reaproveitado entre invocações.

O schema continua de propriedade do repositório da Fase 2 (migrations Prisma);
este repositório apenas documenta e recomenda índices.

## Alternativas consideradas

| Alternativa                     | Motivo da rejeição                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Amazon DynamoDB**             | Criaria segunda fonte de verdade para `cliente` ou exigiria replicação; não suporta lookup por expressão (CPF normalizado); domínio da oficina é relacional. |
| **MySQL / MariaDB (RDS)**       | Sem ganho funcional; exigiria migrar o monolito (enums nativos, `TIMESTAMPTZ`, Prisma provider).                                                             |
| **Aurora PostgreSQL**           | Wire-compatible e melhor HA, mas custo mínimo desproporcional ao MVP e mais recursos no Learner Lab. Fica como evolução (troca de endpoint).                 |
| **PostgreSQL em EC2**           | Mesma engine sem backup/patch/failover gerenciados; custo operacional para equipe pequena.                                                                   |
| **Banco separado só para auth** | Duplicação de `cliente` e risco de `sub` divergente entre token e aplicação.                                                                                 |

Análise completa: [docs/arquitetura/banco-de-dados.md](../arquitetura/banco-de-dados.md).

## Consequências

### Positivas

- Zero mudança no monolito para a Lambda funcionar; mesmos IDs, mesma tabela.
- Constraints (`NOT NULL`, `UNIQUE`, FKs, enums) e transações ACID garantidas
  pelo banco para todo o domínio.
- Operação gerenciada: backups automáticos, patching, Multi-AZ opcional,
  Performance Insights.
- Segurança em camadas: VPC privada + TLS + Secrets Manager.

### Negativas / trade-offs

- **Conexões Lambda ↔ RDS.** Lambda escala por container e cada container abre
  sua própria conexão; sem controle, N containers → N conexões e o RDS
  (`max_connections` ≈ 80 em `db.t3.micro`) satura. Mitigação adotada: `max: 1`
  por container, pool em cache no escopo do módulo, `idleTimeoutMillis: 30 s`,
  `allowExitOnIdle`. Próximos passos quando a concorrência crescer: limitar
  `reserved_concurrency` da function e/ou introduzir **RDS Proxy** (multiplexa
  conexões e reduz custo de handshake TLS no cold start).
- **Cold start maior**: function em VPC + handshake TLS + `SELECT` inicial.
  Parcialmente mitigado pelo cache do pool e de segredos em `container.ts`.
- **Lookup de CPF sem índice utilizável**: a expressão `regexp_replace(...)` no
  `WHERE` ignora o `UNIQUE (cpf_cnpj)` e força Seq Scan. Ação requerida no
  repositório da Fase 2: índice funcional
  `CREATE UNIQUE INDEX ... ON cliente (regexp_replace(cpf_cnpj, '[^0-9]', '', 'g'))`
  (ou normalizar `cpf_cnpj` na escrita).
- **Acoplamento de schema**: alterações em `cliente` no monolito podem quebrar a
  Lambda. Mitigação: nomes de tabela/colunas configuráveis por ambiente
  (`CLIENTE_TABLE`, `CLIENTE_CPF_COLUMN`, `CLIENTE_STATUS_COLUMN`) e coluna de
  status opcional.
- **Divergência local × produção**: `local/init.sql` usa `UUID`/`TIMESTAMPTZ` e
  tem `ativo`; a migration Prisma usa `TEXT`/`TIMESTAMP(3)` e não tem `ativo`.
  Testes locais do cenário 403 dependem de `CLIENTE_STATUS_COLUMN=ativo`.
- `rejectUnauthorized: false` aceita a CA do RDS sem validar a cadeia; endurecer
  com o bundle de CAs da AWS é dívida técnica registrada.
