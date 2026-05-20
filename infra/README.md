# VoiceBot Azure Observability Deployment

This folder deploys the telemetry resources needed for the VoiceBot dashboard:

- Log Analytics workspace
- Workspace-based Application Insights resource
- Azure Monitor workbook from `observability/azure-monitor-workbook.json`
- Optional scheduled query alerts with an email action group

## Deploy

Run the deployment from the repository root with `infra/main.bicep`. Do not copy `infra/main.bicep` to the repository root before compiling it; the template loads `../observability/azure-monitor-workbook.json` relative to the `infra/` folder.

Preview first:

```bash
az deployment group what-if \
  --resource-group <resource-group-name> \
  --template-file infra/main.bicep \
  --parameters namePrefix=voicebot environmentName=prod alertEmail=ops@example.com
```

Deploy:

```bash
az deployment group create \
  --resource-group <resource-group-name> \
  --template-file infra/main.bicep \
  --parameters namePrefix=voicebot environmentName=prod alertEmail=ops@example.com
```

Set the app output connection string as `AZURE_MONITOR_CONNECTION_STRING` and keep `VOICEBOT_TELEMETRY=true`.

The business ROI panels stay at zero until these approved estimate variables are configured in the app environment: `VOICEBOT_BOOKING_COMPLETED_VALUE_USD`, `VOICEBOT_BOOKING_LINK_VALUE_USD`, `VOICEBOT_BOOKING_REQUEST_VALUE_USD`, `VOICEBOT_DEALER_ORDER_CONFIRMED_VALUE_USD`, `VOICEBOT_TRANSFER_VALUE_USD`, `VOICEBOT_COST_PER_CALL_USD`, `VOICEBOT_COST_PER_MINUTE_USD`, `VOICEBOT_INPUT_TOKEN_COST_PER_1K_USD`, and `VOICEBOT_OUTPUT_TOKEN_COST_PER_1K_USD`.
