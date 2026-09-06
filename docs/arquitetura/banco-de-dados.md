# Banco de dados — justificativa da escolha (PostgreSQL no Amazon RDS)

> Documento de arquitetura da Fase 3 (US-F3-DOC-04). Escopo: a Lambda de
> autenticação por CPF deste repositório e a tabela `cliente` que ela consome.
> O domínio completo (veículos, ordens de serviço, estoque, notificações) vive
> no repositório da aplicação Fase 2 —
> https://github.com/guilhermeqmaia/software-architecture-tech-challenge — e é
> referenciado aqui apenas para contextualizar os relacionamentos.
>
> Documentos relacionados: [ADR-0001](../adr/0001-escolha-banco-de-dados.md) ·
> [schema.dbml](schema.dbml) · [Diagrama ER](er-diagram.md)

## 1. Evidências no repositório

Nada abaixo é inferido: cada item aponta para um arquivo versionado neste repo.

| Evidência                             | Onde                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banco declarado: **PostgreSQL (RDS)** | `README.md` — "Runtime: Node.js 20 + TypeScript · Banco: PostgreSQL (RDS) · Segredos: AWS Secrets Manager"                                                                                                                                                    |
| Schema da tabela `cliente`            | `local/init.sql` — `id UUID PK DEFAULT gen_random_uuid()`, `nome TEXT NOT NULL`, `cpf_cnpj TEXT NOT NULL UNIQUE`, `email TEXT`, `telefone TEXT NOT NULL`, `ativo BOOLEAN NOT NULL DEFAULT TRUE`, `created_at`/`updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` |
| Driver e query real                   | `src/infra/postgres-cliente.repository.ts` — `pg.Pool` com `max: 1`; `WHERE regexp_replace("cpf_cnpj", '[^0-9]', '', 'g') = $1 LIMIT 1`                                                                                                                       |
| Lambda dentro da VPC do RDS           | `infra/terraform/main.tf` (`vpc_config` com `subnet_ids` / `security_group_ids`) e `infra/terraform/variables.tf` ("Subnets privadas com rota para o RDS")                                                                                                    |
| SSL obrigatório                       | `infra/terraform/main.tf` — `DB_SSL = "true"`; `postgres-cliente.repository.ts` habilita `ssl` no pool                                                                                                                                                        |
| Credenciais fora do código            | `infra/terraform/main.tf` — `aws_secretsmanager_secret.db` com `DATABASE_URL`; `variables.tf` valida `startswith(var.database_url, "postgres")`                                                                                                               |
| Timeouts de conexão/statement         | `src/config/env.ts` (`dbConnectionTimeoutMs`, `dbQueryTimeoutMs`) → `connectionTimeoutMillis`, `query_timeout`, `statement_timeout` no pool                                                                                                                   |
| Nome de tabela/colunas configuráveis  | `variables.tf` — `cliente_table = "cliente"`, `cliente_cpf_column = "cpf_cnpj"`, `cliente_status_column` (opcional)                                                                                                                                           |

### Divergência conhecida entre `local/init.sql` e o banco da Fase 2

`local/init.sql` é um banco de **teste local** ("reproduz a tabela `cliente` do
monolito e acrescenta a coluna `ativo`"). O schema efetivamente aplicado pelo
monolito (Prisma, `prisma/migrations/20260413191601_add_cliente_table`) difere em
três pontos:

| Coluna                    | `local/init.sql` (este repo)         | Migration Prisma (Fase 2)                      |
| ------------------------- | ------------------------------------ | ---------------------------------------------- |
| `id`                      | `UUID DEFAULT gen_random_uuid()`     | `TEXT` (UUID v4 gerado pela aplicação)         |
| `created_at`/`updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | `TIMESTAMP(3)`; `updated_at` sem default (ORM) |
| `ativo`                   | `BOOLEAN NOT NULL DEFAULT TRUE`      | **não existe**                                 |

A Lambda tolera as duas variantes: faz `"id"::text` no `SELECT` e só lê a
coluna de status quando `CLIENTE_STATUS_COLUMN` está definida (`src/config/env.ts`).
Em produção, o schema de referência é o do monolito.

## 2. Requisitos que o banco precisa atender

1. **Lookup pontual por CPF** com latência baixa (p99 bem abaixo do `timeout` de
   15 s da function) — é a única query da Lambda.
2. **Unicidade de CPF/CNPJ** garantida pelo banco, não pela aplicação.
3. **Compartilhar a mesma base com o monolito Fase 2** (mesma tabela `cliente`,
   mesmos IDs no `sub` do JWT) — não faz sentido um banco separado só para auth.
4. **Integridade referencial** para o domínio da oficina (`veiculo`,
   `ordem_de_servico`, itens, estoque), que é relacional por natureza.
5. **Operação gerenciada** (backup, patch, failover) em conta AWS Academy/Learner
   Lab, onde há restrições de IAM (`variables.tf`, comentário em `lambda_role_arn`).
6. **Segurança**: tráfego cifrado, credenciais em Secrets Manager, banco em
   subnet privada.

## 3. Alternativas consideradas

| Critério                                 | **PostgreSQL no RDS** (escolhido)              | Aurora PostgreSQL                                        | MySQL / MariaDB (RDS)                                | DynamoDB                                        | PostgreSQL em EC2                             |
| ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| Compatível com o monolito (Prisma + PG)  | Sim, sem alteração                             | Sim (wire-compatible)                                    | Exige migrar schema, enums e código                  | Exige reescrever o modelo e repositórios        | Sim                                           |
| Modelo relacional / FKs / enums nativos  | Sim (`ENUM`, FKs `ON DELETE CASCADE/SET NULL`) | Sim                                                      | Parcial (enums menos expressivos, sem `TIMESTAMPTZ`) | Não (relacionamentos modelados na aplicação)    | Sim                                           |
| Índice funcional (`regexp_replace(...)`) | Sim                                            | Sim                                                      | Só via coluna gerada                                 | Não (exigiria atributo normalizado + GSI)       | Sim                                           |
| Transações ACID multi-tabela             | Sim                                            | Sim                                                      | Sim (InnoDB)                                         | Limitadas (`TransactWriteItems`, até 100 itens) | Sim                                           |
| Custo em ambiente acadêmico              | Baixo (`db.t3/t4g.micro`, free tier)           | Mais alto (mínimo 2 ACUs ou instância + storage por I/O) | Baixo                                                | Baixo, mas exige remodelagem                    | Baixo, porém sem operação gerenciada          |
| Operação gerenciada (backup/patch/HA)    | Sim (Multi-AZ opcional)                        | Sim (melhor HA)                                          | Sim                                                  | Sim (serverless)                                | **Não** — patching, backup e failover manuais |
| Conexões a partir de Lambda              | Limitadas → mitigar com `max: 1`/RDS Proxy     | Idem (RDS Proxy ou Data API)                             | Idem                                                 | Sem conexões persistentes (HTTP)                | Idem, sem RDS Proxy                           |
| Permissões IAM no Learner Lab            | Provisionável (`LabRole`)                      | Provisionável, mas mais recursos                         | Provisionável                                        | Provisionável                                   | Provisionável                                 |

### Por que não cada alternativa

- **DynamoDB** — resolveria a limitação de conexões da Lambda, mas a Lambda é
  apenas um consumidor de uma tabela que pertence ao monolito relacional. Adotar
  DynamoDB só para auth criaria duas fontes de verdade para `cliente` (ou um
  pipeline de replicação) e impediria a normalização do CPF em query. Além
  disso, o domínio da oficina (OS ↔ itens ↔ produtos ↔ estoque) depende de
  transações multi-tabela e agregações que o modelo chave-valor não favorece.
- **MySQL / MariaDB** — não há ganho funcional e o monolito já está em
  PostgreSQL (Prisma `provider = "postgresql"`, `ENUM`s nativos como
  `StatusOrdemDeServico`). Migrar teria custo sem benefício.
- **Aurora PostgreSQL** — tecnicamente superior em HA e escala de leitura, mas o
  custo mínimo é desproporcional ao volume do MVP e, no Learner Lab, adiciona
  recursos (cluster + instâncias) sem necessidade. É a evolução natural se a
  carga crescer: a troca é só de endpoint.
- **PostgreSQL auto-hospedado em EC2** — mesma engine, porém sem backup
  automático, patching, monitoramento (Enhanced Monitoring/Performance Insights)
  nem failover. Para uma equipe pequena, o custo operacional supera a economia.

## 4. Performance

### 4.1 O lookup de CPF não usa o índice UNIQUE de `cpf_cnpj`

A query em `src/infra/postgres-cliente.repository.ts` normaliza a coluna em
tempo de execução para aceitar CPF gravado com ou sem máscara:

```sql
SELECT "id"::text AS id, "nome", "cpf_cnpj" AS cpf
  FROM "cliente"
 WHERE regexp_replace("cpf_cnpj", '[^0-9]', '', 'g') = $1
 LIMIT 1;
```

O índice `UNIQUE (cpf_cnpj)` indexa o **valor bruto** da coluna; como o predicado
é sobre uma **expressão**, o planner faz **Seq Scan** na tabela inteira
(O(n) e crescente com a base de clientes). Com poucas linhas isso é invisível;
em produção degrada a latência do `POST /auth` e do cold start.

**Recomendação: índice funcional equivalente** (a expressão deve ser idêntica à
da query para ser utilizada):

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cliente_cpf_cnpj_digits_idx
  ON cliente (regexp_replace(cpf_cnpj, '[^0-9]', '', 'g'));
```

- `UNIQUE` também impede que o mesmo documento exista mascarado e sem máscara
  (`529.982.247-25` e `52998224725`), o que hoje o `UNIQUE (cpf_cnpj)` **não**
  garante e faria `LIMIT 1` escolher uma linha arbitrária.
- `CONCURRENTLY` evita lock de escrita durante a criação (não pode rodar dentro
  de transação — atenção ao aplicar via migration Prisma; use `-- prisma
migrate` com o SQL fora de `BEGIN/COMMIT` ou aplique manualmente).
- Verificação: `EXPLAIN ANALYZE` da query deve mostrar
  `Index Scan using cliente_cpf_cnpj_digits_idx`.
- Como esta Lambda **não é dona do schema**, o índice deve ser criado no
  repositório da Fase 2 (migration Prisma) — ver ADR-0001. Enquanto não existir,
  `local/init.sql` pode recebê-lo para testes locais sem impacto em produção.

Alternativa de longo prazo: persistir `cpf_cnpj` já normalizado (apenas
dígitos) no monolito e trocar o predicado para `"cpf_cnpj" = $1`, usando o
índice UNIQUE existente. A Lambda já suporta isso sem mudança de código, pois o
parâmetro `$1` é o CPF normalizado.

### 4.2 Índices para consultas e dashboards (domínio Fase 2)

Consultas de listagem/monitoramento (US-17 "OS Listing + Average Time
Monitoring", notificações, movimentação de estoque) já contam com índices
definidos no schema Prisma da Fase 2:

| Tabela                       | Índice existente                                    | Consulta atendida                         |
| ---------------------------- | --------------------------------------------------- | ----------------------------------------- |
| `movimentacao_estoque`       | `(produto_id, created_at)`, `(ordem_de_servico_id)` | Extrato por produto; movimentos de uma OS |
| `ordem_de_servico_audit_log` | `(ordem_de_servico_id, created_at)`                 | Linha do tempo de uma OS                  |
| `notificacao`                | `(cliente_id)`, `(ordem_de_servico_id)`             | Notificações por cliente/OS               |
| `ordem_de_servico`           | `UNIQUE (numero)`                                   | Busca por número da OS                    |

Índices **recomendados** (não existem hoje) para dashboards de status e tempo
médio por etapa:

```sql
-- Dashboard "OS por status" e fila de trabalho por status/data
CREATE INDEX CONCURRENTLY IF NOT EXISTS ordem_de_servico_status_created_idx
  ON ordem_de_servico (status, created_at DESC);

-- Acompanhamento do cliente (US-16): OS de um cliente ordenadas
CREATE INDEX CONCURRENTLY IF NOT EXISTS ordem_de_servico_cliente_created_idx
  ON ordem_de_servico (cliente_id, created_at DESC);

-- Tempo médio de execução por serviço (itens concluídos)
CREATE INDEX CONCURRENTLY IF NOT EXISTS item_os_servico_status_fim_idx
  ON item_ordem_de_servico_servico (status_execucao, fim_execucao)
  WHERE status_execucao = 'CONCLUIDO';

-- Veículos de um cliente
CREATE INDEX CONCURRENTLY IF NOT EXISTS veiculo_cliente_idx
  ON veiculo (cliente_id);
```

Regras seguidas: colunas de FK sem índice (`veiculo.cliente_id`,
`ordem_de_servico.cliente_id/veiculo_id`) recebem índice porque PostgreSQL não
os cria automaticamente para FKs; índices parciais (`WHERE ...`) para filtros
fixos de dashboard; ordem `(filtro, ordenação)` para permitir `Index Scan` com
`ORDER BY ... DESC LIMIT`.

### 4.3 Conexões: Lambda ↔ RDS

Cada container da Lambda mantém **1 conexão** (`max: 1`) reaproveitada entre
invocações quentes (`container.ts` faz cache do pool). Com N containers
simultâneos há N conexões; o `max_connections` do RDS depende da classe
(`db.t3.micro` ≈ 80). Mitigações, em ordem de esforço:

1. Manter `max: 1` + `idleTimeoutMillis: 30 s` + `allowExitOnIdle` (já feito).
2. Limitar `reserved_concurrency` da function ao orçamento de conexões.
3. **RDS Proxy** entre Lambda e RDS (multiplexa conexões, reduz cold start de
   TLS e mantém pool no lado do servidor) — recomendado antes de escalar.

## 5. Consistência e integridade

| Mecanismo                                        | Aplicação neste sistema                                                                                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT NULL`                                       | `nome`, `cpf_cnpj`, `telefone`, `ativo`, `created_at`, `updated_at` — a Lambda assume `nome` e `cpf` sempre presentes ao montar as claims do JWT                                                                                                     |
| `UNIQUE (cpf_cnpj)`                              | Um CPF/CNPJ ↔ um cliente; é o que permite `LIMIT 1` sem ambiguidade (ver ressalva sobre máscara em 4.1)                                                                                                                                              |
| `PRIMARY KEY (id)` UUID                          | `sub` do JWT; estável e não sequencial (não vaza volume de clientes)                                                                                                                                                                                 |
| `DEFAULT` (`gen_random_uuid()`, `NOW()`, `TRUE`) | Inserção mínima consistente sem depender da aplicação                                                                                                                                                                                                |
| Chaves estrangeiras (Fase 2)                     | `veiculo.cliente_id → cliente.id`; `ordem_de_servico.cliente_id → cliente.id ON DELETE CASCADE`; `ordem_de_servico.veiculo_id → veiculo.id ON DELETE CASCADE`; `ordem_de_servico.usuario_id → usuario.id ON DELETE SET NULL`; itens de OS em cascata |
| `UNIQUE` compostos (Fase 2)                      | `(ordem_de_servico_id, servico_id)` e `(item_ordem_de_servico_servico_id, produto_id)` — sem itens duplicados numa OS                                                                                                                                |
| Enums nativos (Fase 2)                           | `StatusOrdemDeServico`, `StatusExecucaoItem`, `TipoMovimentacaoEstoque`, `Role`, … — estados inválidos rejeitados pelo banco                                                                                                                         |
| Transações ACID                                  | Aprovação de orçamento → `EM_EXECUCAO` + reserva de estoque + `movimentacao_estoque` + `audit_log` numa única transação; rejeição estorna reservas atomicamente                                                                                      |
| Isolamento                                       | `READ COMMITTED` (default) é suficiente para a Lambda (somente leitura). Operações de estoque no monolito devem usar `UPDATE ... WHERE quantidade_estoque >= $n` ou `SELECT ... FOR UPDATE`                                                          |
| Somente leitura pela Lambda                      | A function só executa `SELECT`; recomenda-se um usuário de banco com `GRANT SELECT ON cliente` para o secret `DATABASE_URL` da Lambda (princípio do menor privilégio)                                                                                |
| TLS em trânsito                                  | `DB_SSL=true`; `rejectUnauthorized: false` aceita a CA própria do RDS — endurecer com o bundle `global-bundle.pem` da AWS quando possível                                                                                                            |

## 6. Decisão

**PostgreSQL gerenciado no Amazon RDS**, compartilhado com o monolito Fase 2,
acessado pela Lambda dentro da VPC com TLS, credenciais no Secrets Manager e
pool de 1 conexão por container. Detalhes e consequências formais em
[ADR-0001](../adr/0001-escolha-banco-de-dados.md).
