# Line na Microsoft Store

Quem instala pela Store não vê o aviso do SmartScreen: a Microsoft assina o pacote na publicação.
O CI já gera o pacote (`Line_0.1.N_x64.msix`) em toda build, no artefato **Line-microsoft-store**
e na release `build-N` do GitHub.

## Uma vez só

1. Crie a conta de desenvolvedor individual (grátis) em https://storedeveloper.microsoft.com
   e entre na Partner Center (https://partner.microsoft.com/dashboard/apps-and-games/overview).
2. **Apps e jogos → Novo produto → App MSIX ou PWA**, e reserve o nome **Line**
   (reservado: **Line: Chat e Voz**, já é o padrão do CI; se mudar, crie a variável `MSSTORE_DISPLAY_NAME`).
3. Identidade do produto (já está no CI, não precisa configurar nada): `AlexandreSouza.LineChateVoz`,
   publisher `CN=0B1640DA-C2DE-40D6-9091-7568BF2908F8`, ID da Store `9NJ9ZQ9T92QR`. Para trocar, use as
   variáveis `MSSTORE_IDENTITY_NAME`, `MSSTORE_PUBLISHER`, `MSSTORE_PUBLISHER_NAME` e `MSSTORE_DISPLAY_NAME`.

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
leitura): o app percebe que está instalado pela Store e o botão de atualizar abre a página do
Line na Store. Para a Store distribuir uma versão nova, faça um novo envio com o `.msix`
mais recente. O instalador `.exe` do site continua se atualizando sozinho como antes.

Depois de publicado, o Line também fica disponível pelo winget sem configuração extra
(`winget install Line --source msstore`), porque o winget já busca na Store.
