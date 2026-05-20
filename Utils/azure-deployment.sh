#!/usr/bin/env bash

set -euo pipefail

# ============================================================
# VoiceBot Azure Telemetry + Command Center Deployment Script
# ============================================================


# -------- Helpers --------
function header() {
  echo ""
  echo "================================================"
  echo "$1"
  echo "================================================"
}

# -------- Configuration --------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCE_GROUP="voicebot-rg"
LOCATION="eastus"
APPINSIGHTS_NAME="voicebot-insights"
WORKBOOK_NAME="voicebot-command-center"
WORKBOOK_FILE="${VOICEBOT_WORKBOOK_FILE:-$ROOT_DIR/observability/azure-monitor-workbook.json}"

# -------- Interactive Region Selection (Developer UX) --------
# Allow developers to choose region interactively unless running in CI

if [ -z "${CI:-}" ]; then
  echo ""
  echo "Select Azure region for deployment:"
  echo "1) eastus"
  echo "2) westus"
  echo "3) centralus"
  echo "4) westeurope"
  echo "5) southeastasia"
  echo ""

  read -rp "Enter selection [default: $LOCATION]: " REGION_SELECTION || true

  case "$REGION_SELECTION" in
    1) LOCATION="eastus" ;;
    2) LOCATION="westus" ;;
    3) LOCATION="centralus" ;;
    4) LOCATION="westeurope" ;;
    5) LOCATION="southeastasia" ;;
    "") ;;
    *) echo "Invalid selection. Using default region: $LOCATION" ;;
  esac

  echo "Using region: $LOCATION"
fi

# -------- Preconditions --------
header "Checking Azure CLI"

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI not installed."
  echo "Install: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli"
  exit 1
fi

# Ensure required Azure CLI extensions exist.
if ! az extension show --name application-insights >/dev/null 2>&1; then
  echo "Installing Azure Application Insights extension..."
  az extension add --name application-insights >/dev/null
fi

if ! az extension show --name monitor-control-service >/dev/null 2>&1; then
  echo "Installing Azure Monitor extension..."
  az extension add --name monitor-control-service >/dev/null
fi

if ! az account show >/dev/null 2>&1; then
  echo "Azure CLI not authenticated."

  # Detect CI environment (GitHub Actions / Azure DevOps etc.)
  if [ -n "${CI:-}" ]; then
    echo "CI environment detected. Expecting Azure authentication to be handled via service principal."
    echo "If using GitHub Actions use: azure/login action."
    exit 1
  fi

  echo "Starting Azure device login flow..."
  az login --use-device-code >/dev/null
fi

# -------- CI Safety Guard --------
# Prevent interactive prompts in CI/CD environments

if [ -n "${CI:-}" ]; then
  echo "Running in CI mode. Interactive prompts disabled."
fi

# -------- Auto‑Select Subscription (SaaS Installer UX) --------
# Automatically pick default subscription if multiple exist
SUBSCRIPTION_COUNT=$(az account list --query "length(@)" -o tsv)

if [ "$SUBSCRIPTION_COUNT" -gt 1 ]; then
  DEFAULT_SUB=$(az account list --query "[?isDefault].id | [0]" -o tsv)

  if [ -n "$DEFAULT_SUB" ]; then
    echo "Using default Azure subscription: $DEFAULT_SUB"
    az account set --subscription "$DEFAULT_SUB"
  else
    FIRST_SUB=$(az account list --query "[0].id" -o tsv)
    echo "No default subscription set. Using first available: $FIRST_SUB"
    az account set --subscription "$FIRST_SUB"
  fi
fi

# -------- Deployment Safety Confirmation --------
# Prevent accidental deployment to wrong subscription

CURRENT_SUB_NAME=$(az account show --query name -o tsv)
CURRENT_SUB_ID=$(az account show --query id -o tsv)

echo ""
echo "Deploying to Azure subscription:"
echo "Name: $CURRENT_SUB_NAME"
echo "ID:   $CURRENT_SUB_ID"
echo ""

if [ -z "${CI:-}" ]; then
  read -rp "Continue deployment to this subscription? (y/N): " CONFIRM || true
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "Deployment cancelled."
    exit 1
  fi
fi

# -------- Create Resource Group --------
header "Creating Resource Group"

az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none

echo "Resource group ready."

# -------- Create Application Insights --------
header "Ensuring Application Insights Exists"

if az monitor app-insights component show \
  --app "$APPINSIGHTS_NAME" \
  --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then

  echo "Application Insights already exists."

else

  az monitor app-insights component create \
    --app "$APPINSIGHTS_NAME" \
    --location "$LOCATION" \
    --resource-group "$RESOURCE_GROUP" \
    --application-type web \
    --output none

  echo "Application Insights created."

fi

# -------- Fetch Connection String --------
header "Fetching Application Insights Connection String"

CONNECTION_STRING=$(az monitor app-insights component show \
  --app "$APPINSIGHTS_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query connectionString \
  -o tsv)

echo ""
echo "Use this connection string in your environment:"
echo ""
echo "AZURE_MONITOR_CONNECTION_STRING=$CONNECTION_STRING"
echo ""

# -------- Deploy Workbook (Command Center Dashboard) --------
header "Deploying Azure Workbook Dashboard"

if [ ! -f "$WORKBOOK_FILE" ]; then
  echo "Canonical workbook file not found: $WORKBOOK_FILE"
  echo "Run this script from a complete repository checkout, or set VOICEBOT_WORKBOOK_FILE to a valid workbook JSON file."
  exit 1
fi

echo "Using workbook template: $WORKBOOK_FILE"

WORKBOOK_ID=$(uuidgen)

APP_ID=$(az monitor app-insights component show \
  --app "$APPINSIGHTS_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query id \
  -o tsv)

az monitor workbook create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WORKBOOK_ID" \
  --display-name "$WORKBOOK_NAME" \
  --location "$LOCATION" \
  --source-id "$APP_ID" \
  --serialized-data @"$WORKBOOK_FILE" \
  --output none

echo "Workbook deployed."

# -------- Optional: Create Latency Alert --------
header "Ensuring Latency Alert Exists"

APP_ID=$(az monitor app-insights component show \
  --app "$APPINSIGHTS_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query id \
  -o tsv)

if az monitor metrics alert show \
  --name "voicebot-high-latency" \
  --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then

  echo "Latency alert already exists."

else

  az monitor metrics alert create \
    --name "voicebot-high-latency" \
    --resource-group "$RESOURCE_GROUP" \
    --scopes "$APP_ID" \
    --condition "avg requests/duration > 800" \
    --description "VoiceBot latency spike detected" \
    --evaluation-frequency 1m \
    --window-size 5m \
    --severity 3 \
    --output none

  echo "Latency alert created."

fi

# -------- Completion --------
header "Deployment Complete"

echo "VoiceBot telemetry infrastructure is ready."
echo ""
echo "Next steps:"
echo "1. Export the connection string:"
echo "   export AZURE_MONITOR_CONNECTION_STRING=\"$CONNECTION_STRING\""
echo ""
echo "2. Start VoiceBot."
echo ""
echo "3. Open Azure Monitor → Application Insights → Workbooks."
echo ""
echo "4. Open '$WORKBOOK_NAME' to view the VoiceBot Command Center."

# -------- Open Dashboard Automatically (Improved UX) --------
PORTAL_LINK="https://portal.azure.com/#resource${APP_ID}/workbooks"

echo ""
echo "Open the VoiceBot Command Center:"
echo "$PORTAL_LINK"
echo ""

# Attempt automatic browser launch
if command -v open >/dev/null 2>&1; then
  open "$PORTAL_LINK" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$PORTAL_LINK" >/dev/null 2>&1 || true
fi

echo "If the browser did not open automatically, copy the link above."