targetScope = 'resourceGroup'

@description('Short workload name used in Azure resource names.')
param namePrefix string = 'voicebot'

@description('Deployment environment. Use one Application Insights resource per workload per environment.')
@allowed([
  'dev'
  'test'
  'staging'
  'prod'
])
param environmentName string = 'prod'

@description('Azure region for Log Analytics and Application Insights. Keep this close to the app workload.')
param location string = resourceGroup().location

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 90

@description('Daily ingestion cap in GB. Use -1 for unlimited; set a production value after measuring normal ingestion.')
param dailyQuotaGb int = -1

@description('Optional email receiver for Azure Monitor scheduled query alerts. Leave empty to deploy without alert actions.')
param alertEmail string = ''

var normalizedName = toLower(replace('${namePrefix}-${environmentName}', '_', '-'))
var workspaceName = '${normalizedName}-logs'
var appInsightsName = '${normalizedName}-appi'
var workbookDisplayName = 'VoiceBot Operations and Business Dashboard (${environmentName})'
var workbookSerializedData = loadTextContent('../observability/azure-monitor-workbook.json')
var hasAlertEmail = !empty(alertEmail)
var eventNameExpression = 'case(isnotempty(tostring(name)), tostring(name), isnotempty(tostring(customDimensions["microsoft.custom_event.name"])), tostring(customDimensions["microsoft.custom_event.name"]), tostring(customDimensions.eventType))'
var callIdExpression = 'case(isnotempty(tostring(customDimensions.callId)), tostring(customDimensions.callId), isnotempty(tostring(customDimensions.callSID)), tostring(customDimensions.callSID), isnotempty(tostring(customDimensions.callSid)), tostring(customDimensions.callSid), tostring(customDimensions.sid))'

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    features: {
      disableLocalAuth: false
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    Request_Source: 'rest'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    DisableIpMasking: false
    DisableLocalAuth: false
    RetentionInDays: retentionInDays
    SamplingPercentage: 100
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, appInsights.id, workbookDisplayName)
  location: location
  kind: 'shared'
  properties: {
    displayName: workbookDisplayName
    serializedData: workbookSerializedData
    version: 'Notebook/1.0'
    category: 'workbook'
    sourceId: appInsights.id
    description: 'VoiceBot end-to-end call, booking, reliability, and ROI dashboard.'
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2024-10-01-preview' = if (hasAlertEmail) {
  name: '${normalizedName}-ops-ag'
  location: 'global'
  properties: {
    groupShortName: 'voicebot'
    enabled: true
    emailReceivers: [
      {
        name: 'operations-email'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource errorRateAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = if (hasAlertEmail) {
  name: '${normalizedName}-error-rate'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'VoiceBot Error Rate > 5 in 5m'
    description: 'Critical runtime, provider, and finalization errors exceeded the operational threshold.'
    enabled: true
    autoMitigate: null
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    severity: 2
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          query: 'customEvents | extend eventName = ${eventNameExpression} | where eventName in ("rag_error", "realtime_connection_error", "realtime_service_error", "booking_provider_error", "call_finalization_degraded", "uncaught_exception", "unhandled_rejection") | summarize errorCount = count()'
          timeAggregation: 'Total'
          metricMeasureColumn: 'errorCount'
          operator: 'GreaterThan'
          threshold: 5
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
    resolveConfiguration: {
      autoResolved: true
      timeToResolve: 'PT10M'
    }
  }
}

resource latencyAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = if (hasAlertEmail) {
  name: '${normalizedName}-latency-p95'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'VoiceBot Response Latency P95 > 1200ms'
    description: 'P95 response latency breached the voice UX SLO.'
    enabled: true
    autoMitigate: null
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    severity: 2
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          query: 'customEvents | extend eventName = ${eventNameExpression} | where eventName == "response_latency" | extend latencyMs = coalesce(todouble(customDimensions.responseLatencyMs), todouble(customDimensions.latencyMs)) | where isnotnull(latencyMs) | summarize p95 = percentile(latencyMs, 95)'
          timeAggregation: 'Average'
          metricMeasureColumn: 'p95'
          operator: 'GreaterThan'
          threshold: 1200
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
    resolveConfiguration: {
      autoResolved: true
      timeToResolve: 'PT10M'
    }
  }
}

resource bookingCompletionAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = if (hasAlertEmail) {
  name: '${normalizedName}-booking-completion-rate'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'VoiceBot Booking Completion Rate < 5%'
    description: 'Completed bookings from provider webhooks dropped below the configured business threshold.'
    enabled: true
    autoMitigate: null
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT30M'
    windowSize: 'PT2H'
    severity: 3
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          query: 'let VoiceBotEvents = customEvents | extend eventName = ${eventNameExpression}, callId = ${callIdExpression}; let totalCalls = toscalar(VoiceBotEvents | where eventName == "call_summary" and isnotempty(callId) | summarize dcount(callId)); let completedBookings = toscalar(VoiceBotEvents | where eventName in ("booking_completed_webhook", "call_summary") and isnotempty(callId) | extend outcome = tostring(customDimensions.outcome), bookingCompleted = tobool(customDimensions.bookingCompleted) | where eventName == "booking_completed_webhook" or outcome == "booking_completed" or bookingCompleted | summarize dcount(callId)); print completionPct = iif(totalCalls == 0, 100.0, 100.0 * todouble(completedBookings) / todouble(totalCalls))'
          timeAggregation: 'Average'
          metricMeasureColumn: 'completionPct'
          operator: 'LessThan'
          threshold: 5
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
    resolveConfiguration: {
      autoResolved: true
      timeToResolve: 'PT1H'
    }
  }
}

resource bookingIntentDropoffAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = if (hasAlertEmail) {
  name: '${normalizedName}-booking-intent-dropoff'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'VoiceBot Booking Intent Delivery Rate < 50%'
    description: 'Callers with booking intent are not reaching link delivery or completion stages.'
    enabled: true
    autoMitigate: null
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT30M'
    windowSize: 'PT2H'
    severity: 3
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          query: 'let VoiceBotEvents = customEvents | extend eventName = ${eventNameExpression}, callId = ${callIdExpression}; let intentCalls = toscalar(VoiceBotEvents | where eventName in ("booking_intent_detected", "booking_link_requested", "booking_link_delivery_sent", "booking_link_sent") and isnotempty(callId) | summarize dcount(callId)); let deliveredCalls = toscalar(VoiceBotEvents | where eventName in ("booking_link_delivery_sent", "booking_link_sent", "booking_completed_webhook") and isnotempty(callId) | summarize dcount(callId)); print deliveryPct = iif(intentCalls == 0, 100.0, 100.0 * todouble(deliveredCalls) / todouble(intentCalls))'
          timeAggregation: 'Average'
          metricMeasureColumn: 'deliveryPct'
          operator: 'LessThan'
          threshold: 50
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
    resolveConfiguration: {
      autoResolved: true
      timeToResolve: 'PT1H'
    }
  }
}

resource bookingOrphanWebhookAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = if (hasAlertEmail) {
  name: '${normalizedName}-booking-orphan-webhooks'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'VoiceBot Orphan Booking Webhooks > 0'
    description: 'Completed or cancelled booking webhooks cannot be attributed to a valid call.'
    enabled: true
    autoMitigate: null
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT30M'
    windowSize: 'PT2H'
    severity: 2
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          query: 'customEvents | extend eventName = ${eventNameExpression} | where eventName == "booking_webhook_orphaned" | summarize orphanCount = count()'
          timeAggregation: 'Total'
          metricMeasureColumn: 'orphanCount'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
    resolveConfiguration: {
      autoResolved: true
      timeToResolve: 'PT1H'
    }
  }
}

output applicationInsightsName string = appInsights.name
output applicationInsightsResourceId string = appInsights.id
output applicationInsightsConnectionString string = appInsights.properties.ConnectionString
output logAnalyticsWorkspaceName string = workspace.name
output workbookName string = workbook.name
