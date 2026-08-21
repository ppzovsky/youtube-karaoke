# YouTube Karaoke Arcade

Karaokê web em português com busca no catálogo do YouTube, análise vocal local e leaderboard persistido no navegador.

## Configuração

1. Crie uma chave para a YouTube Data API v3 no Google Cloud Console.
2. Copie `.env.example` para `.env.local` e preencha `YOUTUBE_API_KEY`.
3. Instale as dependências com `npm install`.
4. Inicie o projeto com `npm run dev`.

O microfone exige HTTPS em produção. Em desenvolvimento, `localhost` é aceito pelos navegadores modernos.

## Privacidade e dados

- O áudio é processado exclusivamente no navegador e nunca é gravado ou enviado.
- As tentativas ficam em JSON no `localStorage` da máquina.
- O servidor apenas protege a chave e consulta a API oficial do YouTube.

## Verificações

- `npm run test:unit`: regras de busca, pontuação, armazenamento e ranking.
- `npm run build`: compilação de produção.
- `npm test`: executa testes de lógica e validação do HTML renderizado.
