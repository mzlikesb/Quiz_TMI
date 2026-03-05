#!/bin/bash
PROJECT_ID="gemini-agent-challenge-489100"
REGION="us-central1"
SERVICE_NAME="quiz-tmi"

echo "Deploying to Cloud Run: $SERVICE_NAME..."
gcloud run deploy $SERVICE_NAME \
  --source . \
  --project $PROJECT_ID \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,VERTEX_LOCATION=$REGION,GEMINI_MODEL=gemini-2.5-flash-native-audio-preview-12-2025,FIRESTORE_DATABASE=quiz-tmi" \
  --timeout=3600 \
  --min-instances=0 \
  --max-instances=10

echo "Deployment finished."
