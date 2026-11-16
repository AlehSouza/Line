# Line na Microsoft Store

Quem instala pela Store não vê o aviso do SmartScreen: a Microsoft assina o pacote na publicação.
O CI já gera o pacote (`Line_0.1.N_x64.msix`) em toda build, no artefato **Line-microsoft-store**
e na release `build-N` do GitHub.

## Uma vez só

1. Crie a conta de desenvolvedor individual (grátis) em https://storedeveloper.microsoft.com
   e entre na Partner Center (https://partner.microsoft.com/dashboard/apps-and-games/overview).
2. **Apps e jogos → Novo produto → App MSIX ou PWA**, e reserve o nome **Line**
   (se estiver ocupado, algo como "Line Chat").
3. No produto, abra **Gerenciamento de produto → Identidade do produto** e copie três valores para
   o GitHub, em **Settings → Secrets and variables → Actions → Variables**:
   - `MSSTORE_IDENTITY_NAME` ← *Package/Identity/Name* (ex.: `12345Xande.Line`)
   - `MSSTORE_PUBLISHER` ← *Package/Identity/Publisher* (ex.: `CN=1A2B3C4D-...`)
   - `MSSTORE_PUBLISHER_NAME` ← *Package/Properties/PublisherDisplayName*
4. Rode o CI de novo (Actions → CI → Run workflow) para o pacote sair com essa identidade.

## Cada envio

1. Baixe o `.msix` da release mais nova no GitHub.
2. Na Partner Center, **Iniciar envio** e preencha:
   - **Preços e disponibilidade:** grátis.
   - **Propriedades:** categoria *Social*; política de privacidade
     `https://useline.tech/site/privacidade.html`; site `https://useline.tech`.
     Marque que o app acessa microfone e câmera.
   - **Classificação etária:** responder o questionário (tem chat entre usuários).
   - **Pacotes:** arraste o `.msix`.
   - **Listagem da Store (pt-BR):** descrição e pelo menos 1 captura de tela (1366x768 ou maior).
   - **Opções de envio → capacidades restritas:** justificar `runFullTrust`
     ("app de desktop Win32 empacotado; precisa capturar tela e áudio do sistema e mostrar ícone na bandeja").
3. Envie. A certificação costuma levar de algumas horas a 3 dias.

## Atualizações

A versão da Store não usa o atualizador próprio do Line (a Store não deixa e a pasta do app é só
leitura): o app percebe que está instalado pela Store e o botão de atualizar abre a página de
atualizações da Store. Para a Store distribuir uma versão nova, faça um novo envio com o `.msix`
mais recente. O instalador `.exe` do site continua se atualizando sozinho como antes.

Depois de publicado, o Line também fica disponível pelo winget sem configuração extra
(`winget install Line --source msstore`), porque o winget já busca na Store.
