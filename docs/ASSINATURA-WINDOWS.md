# Assinatura do instalador no Windows

Sem assinatura de código, o SmartScreen mostra "O Windows protegeu o computador" ao abrir o instalador.
Quem baixa pode seguir em **Mais informações → Executar assim mesmo**. Para o aviso sumir, o `.exe` precisa ser assinado.

## Ligar a assinatura no CI (Azure Trusted Signing)

O job `windows` do CI já está pronto: assina sozinho quando estes itens existirem no repositório
(Settings → Secrets and variables → Actions).

Secrets:
- `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`: de um App Registration no Azure com o papel
  *Trusted Signing Certificate Profile Signer* na conta de assinatura.

Variables:
- `AZURE_SIGNING_ENDPOINT`: ex. `https://eus.codesigning.azure.net` (depende da região da conta)
- `AZURE_SIGNING_ACCOUNT`: nome da conta de Trusted Signing
- `AZURE_SIGNING_PROFILE`: nome do perfil de certificado

Sem esses itens, o build continua igual (instalador sem assinatura).
