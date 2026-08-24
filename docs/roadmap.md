# Roadmap

This roadmap is limited to the direction already visible in the repository; it does not propose unrelated product features.

1. **Complete the current AI Tutor workflow.** The interface currently renders a chat form and accepts audio/image selections, but its send action has no connected tutoring endpoint. The existing notes, image-to-notes, transcription, authentication, and usage-limit foundations show the intended study-assistance direction.
2. **Harden existing integrations for deployment.** Finish production configuration and verification for Supabase, OpenAI, Deepgram, Stripe, email delivery, deployment origins, and webhooks using the environment-variable and deployment files already in the project.
3. **Validate the established study and sharing flows.** Add automated coverage around authenticated CRUD, public publishing/search, profile media, account lifecycle, AI usage limits, subscriptions, and WebSocket notifications.
4. **Improve operational confidence.** Use the existing health check, analytics-event ingestion, and deployment configuration to make failures and usage patterns easier to verify during development and release.
