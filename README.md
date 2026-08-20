# Integração corrigida com a Shopee Open API V2

Esta versão substitui a tentativa de chamada GraphQL direta no navegador por um backend Node.js que recebe, por HTTPS, a URL/API, o AppID ou Partner ID e a senha/Partner Key disponibilizados pela Shopee ao afiliado. O backend executa OAuth, mantém os segredos fora do frontend, calcula a assinatura HMAC-SHA256 e consulta o endpoint REST oficial de conversões.

## O que foi corrigido

O HTML original enviava credenciais diretamente do navegador e tentava chamar um endpoint GraphQL fictício/compatível com uma resposta `conversionReport`. Ele também usava um CORS proxy público. Esse fluxo expunha credenciais, dependia de um serviço intermediário não controlado e não correspondia ao formato atual do endpoint oficial.

A versão corrigida usa o fluxo OAuth da Shopee. O usuário autoriza a loja, o callback troca o código por `access_token` e `refresh_token`, o backend assina cada chamada com `partner_id + api_path + timestamp + access_token + shop_id` e consulta `GET /api/v2/ams/get_conversion_report`. A resposta REST é convertida para o formato que o painel já entende.

## Configuração

O afiliado informa no formulário do painel a URL da API, o AppID ou Partner ID e a senha/Partner Key fornecidos pela Shopee. Esses dados são enviados ao backend por HTTPS e ficam apenas na sessão do servidor; não são salvos no HTML, no localStorage ou em repositório público.

O arquivo `.env` é opcional e pode ser usado apenas como fallback em ambiente controlado. Copie `.env.example` para `.env` se desejar configurar valores padrão no servidor.

No Console da Shopee, configure o domínio de callback usado pelo aplicativo. Em ambiente local, o callback padrão é:

`http://localhost:3000/api/shopee/callback`

Execute:

```bash
cp .env.example .env
# edite .env com as credenciais reais
npm start
```

Depois abra `http://localhost:3000`, preencha os três campos de afiliado e clique em **Autorizar conta de afiliado Shopee**. Ao concluir a autorização, volte ao painel e clique em **Sincronizar vendas Shopee**.

## Rotas do backend

| Rota | Método | Função |
| --- | --- | --- |
| `/api/shopee/auth-url` | GET | Gera a URL OAuth com `state` anti-CSRF. |
| `/api/shopee/callback` | GET | Recebe `code` e `shop_id`, troca o código por tokens e cria a sessão. |
| `/api/shopee/status` | GET | Informa se a sessão possui uma loja autorizada. |
| `/api/shopee/sync` | POST | Busca o relatório de conversões, pagina até 100 páginas e normaliza os registros. |
| `/api/shopee/disconnect` | POST | Remove os tokens da sessão em memória. |

## Observações importantes

O backend usa sessões em memória para facilitar o teste. Em produção, substitua `Map` por Redis ou banco de dados criptografado e persista os tokens por loja. O `refresh_token` da Shopee é rotativo e deve ser substituído pelo novo token retornado no refresh.

A Shopee documenta validade de quatro horas para `access_token`, trinta dias para `refresh_token` e validade máxima de cinco minutos para o timestamp da assinatura. O código renova o token quando ele está próximo de expirar, mas a autorização, o AppID e a senha/Partner Key precisam estar válidos no Console do afiliado.

O endpoint de conversões possui limites de período, paginação e disponibilidade de dados. O código limita a consulta a 90 dias e percorre as páginas enquanto `has_more` for verdadeiro. Para relatórios maiores, use exportação ou sincronização incremental.

## Referência oficial

- [Shopee AMS — get_conversion_report](https://open.shopee.com/documents/v2/v2.ams.get_conversion_report?module=127&type=1)
- [Shopee Authorization and Authentication](https://open.shopee.com/documents?module=87&type=2&id=58&version=2)
