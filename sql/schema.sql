-- QIFLOW 数据库结构快照（由 scripts/export-schema.ts 从真实库反射生成）
-- 用途：手动预建结构的部署场景。常规部署无需执行——应用首次启动自动幂等建表并写入种子数据。
-- 注意：仅含结构（o_* 表 / 主键 / 二级索引）；业务种子数据由应用启动逻辑完成。

-- ── o_agentDeploy ──
CREATE TABLE IF NOT EXISTS "o_agentDeploy" (
  "id" integer NOT NULL,
  "model" varchar(255),
  "key" varchar(255),
  "modelName" varchar(255),
  "vendorId" text,
  "desc" varchar(255),
  "name" varchar(255),
  "temperature" integer,
  "maxOutputTokens" integer,
  "disabled" boolean DEFAULT false,
  "type" varchar(255),
  PRIMARY KEY ("id")
);

-- ── o_agentWorkData ──
CREATE TABLE IF NOT EXISTS "o_agentWorkData" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "episodesId" integer,
  "key" varchar(255),
  "data" text,
  "createTime" bigint,
  "updateTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_agent_trace ──
CREATE TABLE IF NOT EXISTS "o_agent_trace" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "agentKey" varchar(255),
  "stage" varchar(255),
  "gate" varchar(255),
  "event" varchar(255),
  "durationMs" bigint,
  "retryCount" integer,
  "schemaValid" varchar(255),
  "detail" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_artStyle ──
CREATE TABLE IF NOT EXISTS "o_artStyle" (
  "id" integer NOT NULL,
  "name" varchar(255),
  "fileUrl" text,
  "label" text,
  "prompt" text,
  PRIMARY KEY ("id")
);

-- ── o_chapter_arc ──
CREATE TABLE IF NOT EXISTS "o_chapter_arc" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "volumeId" integer,
  "arcIndex" integer,
  "title" text,
  "startChapter" integer,
  "endChapter" integer,
  "contribution" text,
  "createTime" bigint,
  "updateTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_chapter_plan ──
CREATE TABLE IF NOT EXISTS "o_chapter_plan" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "volumeId" integer,
  "chapterIndex" integer,
  "title" text,
  "summary" text,
  "hooks" text,
  "coolPoints" text,
  "foreshadowRefs" text,
  "wordTarget" integer,
  "status" varchar(255) DEFAULT 'planned'::character varying,
  "sortOrder" integer,
  "createTime" bigint,
  "updateTime" bigint,
  "arcId" integer,
  "bookmarked" integer,
  PRIMARY KEY ("id")
);

-- ── o_chapter_version ──
CREATE TABLE IF NOT EXISTS "o_chapter_version" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "novelId" integer,
  "chapterIndex" integer,
  "chapter" text,
  "chapterData" text,
  "source" varchar(255),
  "version" integer,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_chatHistory ──
CREATE TABLE IF NOT EXISTS "o_chatHistory" (
  "id" text NOT NULL,
  "projectId" bigint,
  "agentKey" text NOT NULL,
  "role" text,
  "name" text,
  "content" text NOT NULL,
  "stageKey" text,
  "createTime" bigint NOT NULL,
  PRIMARY KEY ("id")
);

-- ── o_check_report ──
CREATE TABLE IF NOT EXISTS "o_check_report" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "reportType" varchar(255),
  "stageKey" varchar(255),
  "chapterIndex" integer,
  "rating" varchar(255),
  "summary" text,
  "issues" text,
  "metrics" text,
  "detailMd" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_content_audit ──
CREATE TABLE IF NOT EXISTS "o_content_audit" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "sourceType" varchar(255),
  "sourceKey" text,
  "contentSnapshot" text,
  "result" varchar(255),
  "label" varchar(255),
  "score" real,
  "handler" varchar(255),
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_foreshadow ──
CREATE TABLE IF NOT EXISTS "o_foreshadow" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "fsKey" text,
  "description" text,
  "plantedChapterIndex" integer,
  "plannedResolveChapterIndex" integer,
  "resolvedChapterIndex" integer,
  "status" varchar(255) DEFAULT 'planted'::character varying,
  "source" varchar(255) DEFAULT 'outline'::character varying,
  "createTime" bigint,
  "updateTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_ledger_snapshot ──
CREATE TABLE IF NOT EXISTS "o_ledger_snapshot" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "chapterIndex" integer,
  "data" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_market_book_gene ──
CREATE TABLE IF NOT EXISTS "o_market_book_gene" (
  "id" bigint NOT NULL,
  "bookId" text NOT NULL,
  "snapshotDate" date,
  "bookName" text,
  "geneJson" text,
  "modelName" varchar(255),
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_market_rank_snapshot ──
CREATE TABLE IF NOT EXISTS "o_market_rank_snapshot" (
  "id" bigint NOT NULL,
  "snapshotDate" date NOT NULL,
  "platform" varchar(255) DEFAULT 'fanqie'::character varying,
  "rankType" varchar(255) NOT NULL,
  "gender" varchar(255) NOT NULL,
  "category" varchar(255) NOT NULL,
  "bookId" text NOT NULL,
  "bookName" text,
  "author" text,
  "authorId" text,
  "rank" integer,
  "rankChange" integer,
  "status" varchar(255),
  "wordCount" bigint,
  "chapterCount" integer,
  "heatText" text,
  "heatValue" bigint,
  "tags" text[],
  "latestChapter" text,
  "latestUpdateTime" bigint,
  "intro" text,
  "sourceUrl" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_market_schedule_log ──
CREATE TABLE IF NOT EXISTS "o_market_schedule_log" (
  "id" integer NOT NULL,
  "taskType" varchar(255),
  "weekStart" bigint,
  "status" varchar(255),
  "detail" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_market_topic ──
CREATE TABLE IF NOT EXISTS "o_market_topic" (
  "id" bigint NOT NULL,
  "topicName" varchar(255) NOT NULL,
  "gender" varchar(255),
  "category" varchar(255),
  "newbookCount7d" integer DEFAULT 0,
  "growthRate7d" numeric(10,4) DEFAULT '0'::numeric,
  "firstSeenDate" date,
  "daysOnRank" integer DEFAULT 0,
  "avgHeatValue" bigint DEFAULT '0'::bigint,
  "avgWordCount" bigint DEFAULT '0'::bigint,
  "adaptationScore" integer DEFAULT 0,
  "adaptationTier" varchar(255),
  "lifecycle" varchar(255),
  "sampleBookIds" text[],
  "topicType" varchar(255) DEFAULT 'category'::character varying NOT NULL,
  "parentTopic" varchar(255),
  "updateTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_market_topic_pool ──
CREATE TABLE IF NOT EXISTS "o_market_topic_pool" (
  "id" integer NOT NULL,
  "reportId" integer,
  "topicName" varchar(255),
  "gender" varchar(255),
  "category" varchar(255),
  "lifecycle" varchar(255),
  "growthRate" varchar(255),
  "avgHeat" bigint,
  "sampleBooks" text,
  "geneJson" text,
  "oneLineTemplate" text,
  "reason" text,
  "projectId" bigint,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_market_weekly_report ──
CREATE TABLE IF NOT EXISTS "o_market_weekly_report" (
  "id" integer NOT NULL,
  "weekStart" bigint,
  "weekLabel" varchar(255),
  "status" varchar(255),
  "trendJson" text,
  "reasonJson" text,
  "directionJson" text,
  "reportMd" text,
  "errorMsg" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_modelPrompt ──
CREATE TABLE IF NOT EXISTS "o_modelPrompt" (
  "id" integer NOT NULL,
  "vendorId" varchar(255),
  "model" varchar(255),
  "fileName" text,
  "path" text,
  PRIMARY KEY ("id")
);

-- ── o_novel ──
CREATE TABLE IF NOT EXISTS "o_novel" (
  "id" integer NOT NULL,
  "chapterIndex" integer,
  "reel" text,
  "chapter" text,
  "chapterData" text,
  "projectId" bigint,
  "createTime" bigint,
  "volumeId" integer,
  PRIMARY KEY ("id")
);

-- ── o_novel_blueprint ──
CREATE TABLE IF NOT EXISTS "o_novel_blueprint" (
  "id" integer NOT NULL,
  "userId" integer,
  "name" varchar(255),
  "sourceProjectId" bigint,
  "genre" varchar(255),
  "volumePlan" text,
  "eventRhythm" text,
  "charactersDraft" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_novel_embedding ──
CREATE TABLE IF NOT EXISTS "o_novel_embedding" (
  "id" integer NOT NULL,
  "novelId" integer,
  "projectId" bigint,
  "chapterIndex" integer,
  "chunkIndex" integer,
  "chunkText" text,
  "embedding" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_order ──
CREATE TABLE IF NOT EXISTS "o_order" (
  "id" integer NOT NULL,
  "orderNo" varchar(255) NOT NULL,
  "userId" integer,
  "planId" varchar(255),
  "amount" real,
  "channel" varchar(255) DEFAULT 'manual'::character varying,
  "status" varchar(255) DEFAULT 'pending'::character varying,
  "tradeNo" varchar(255),
  "createTime" bigint,
  "payTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_plan ──
CREATE TABLE IF NOT EXISTS "o_plan" (
  "id" varchar(255) NOT NULL,
  "name" varchar(255),
  "price" real,
  "tokensPerMonth" integer,
  "featureFlags" text,
  "status" varchar(255) DEFAULT 'active'::character varying,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_project ──
CREATE TABLE IF NOT EXISTS "o_project" (
  "id" bigint NOT NULL,
  "projectType" varchar(255),
  "imageModel" varchar(255),
  "imageQuality" varchar(255),
  "name" text,
  "intro" text,
  "type" text,
  "artStyle" text,
  "directorManual" text,
  "createTime" bigint,
  "userId" integer,
  "status" varchar(255),
  "deletedAt" bigint,
  "shareToken" varchar(255),
  "seriesId" integer,
  PRIMARY KEY ("id")
);

-- ── o_project_member ──
CREATE TABLE IF NOT EXISTS "o_project_member" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "userId" integer,
  "role" varchar(255) DEFAULT 'editor'::character varying,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_prompt ──
CREATE TABLE IF NOT EXISTS "o_prompt" (
  "id" integer NOT NULL,
  "name" varchar(255),
  "type" varchar(255),
  "data" text,
  "useData" text,
  PRIMARY KEY ("id")
);

-- ── o_push_subscription ──
CREATE TABLE IF NOT EXISTS "o_push_subscription" (
  "id" integer NOT NULL,
  "userId" integer,
  "endpoint" text,
  "p256dh" text,
  "auth" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_series ──
CREATE TABLE IF NOT EXISTS "o_series" (
  "id" integer NOT NULL,
  "userId" integer,
  "name" varchar(255),
  "intro" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_series_setting ──
CREATE TABLE IF NOT EXISTS "o_series_setting" (
  "id" integer NOT NULL,
  "seriesId" integer,
  "stageKey" varchar(255),
  "content" text,
  "updateTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_setting ──
CREATE TABLE IF NOT EXISTS "o_setting" (
  "key" text NOT NULL,
  "value" text,
  PRIMARY KEY ("key")
);

-- ── o_skillAttribution ──
CREATE TABLE IF NOT EXISTS "o_skillAttribution" (
  "skillId" text NOT NULL,
  "attribution" text NOT NULL,
  PRIMARY KEY ("skillId", "attribution")
);

-- ── o_skillList ──
CREATE TABLE IF NOT EXISTS "o_skillList" (
  "id" text NOT NULL,
  "md5" text NOT NULL,
  "path" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "embedding" text,
  "type" text NOT NULL,
  "createTime" bigint NOT NULL,
  "updateTime" bigint NOT NULL,
  "state" integer NOT NULL,
  PRIMARY KEY ("id")
);

-- ── o_stage_version ──
CREATE TABLE IF NOT EXISTS "o_stage_version" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "stageKey" varchar(255),
  "content" text,
  "source" varchar(255),
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_subscription ──
CREATE TABLE IF NOT EXISTS "o_subscription" (
  "id" integer NOT NULL,
  "userId" integer NOT NULL,
  "planId" varchar(255),
  "periodStart" bigint,
  "periodEnd" bigint,
  "tokensUsed" bigint DEFAULT '0'::bigint,
  "status" varchar(255) DEFAULT 'active'::character varying,
  PRIMARY KEY ("id")
);

-- ── o_tasks ──
CREATE TABLE IF NOT EXISTS "o_tasks" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "taskClass" varchar(255),
  "relatedObjects" varchar(255),
  "model" varchar(255),
  "describe" text,
  "state" varchar(255),
  "startTime" bigint,
  "reason" text,
  "promptTokens" integer,
  "completionTokens" integer,
  "totalTokens" integer,
  "cost" real,
  PRIMARY KEY ("id")
);

-- ── o_user ──
CREATE TABLE IF NOT EXISTS "o_user" (
  "id" integer NOT NULL,
  "name" text,
  "password" text,
  "email" text,
  "role" varchar(255),
  "status" varchar(255),
  "createTime" bigint,
  "tokenVersion" integer DEFAULT 0 NOT NULL,
  PRIMARY KEY ("id")
);

-- ── o_user_audit ──
CREATE TABLE IF NOT EXISTS "o_user_audit" (
  "id" integer NOT NULL,
  "userId" integer,
  "action" varchar(255),
  "target" text,
  "ip" varchar(255),
  "detail" text,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_user_notice ──
CREATE TABLE IF NOT EXISTS "o_user_notice" (
  "id" integer NOT NULL,
  "userId" integer,
  "type" varchar(255),
  "title" varchar(255),
  "content" text,
  "readAt" bigint,
  "createTime" bigint,
  PRIMARY KEY ("id")
);

-- ── o_user_pref ──
CREATE TABLE IF NOT EXISTS "o_user_pref" (
  "userId" integer NOT NULL,
  "key" text NOT NULL,
  "value" text,
  "updateTime" bigint,
  PRIMARY KEY ("userId", "key")
);

-- ── o_vendorConfig ──
CREATE TABLE IF NOT EXISTS "o_vendorConfig" (
  "id" varchar(255) NOT NULL,
  "inputValues" text,
  "models" text,
  "enable" integer,
  PRIMARY KEY ("id")
);

-- ── o_volume ──
CREATE TABLE IF NOT EXISTS "o_volume" (
  "id" integer NOT NULL,
  "projectId" bigint,
  "volumeIndex" integer,
  "title" text,
  "summary" text,
  "status" varchar(255) DEFAULT 'planning'::character varying,
  "plannedChapters" integer,
  "createTime" bigint,
  "updateTime" bigint,
  "mainline" text,
  "stageLabel" varchar(255),
  "conflictScale" text,
  "oneLineSummary" text,
  "stories" text,
  PRIMARY KEY ("id")
);

-- ── 二级索引 ──
CREATE UNIQUE INDEX IF NOT EXISTS o_agentdeploy_id_unique ON public."o_agentDeploy" USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_agentworkdata_id_unique ON public."o_agentWorkData" USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_agentworkdata_projectid_key_unique ON public."o_agentWorkData" USING btree ("projectId", key);
CREATE UNIQUE INDEX IF NOT EXISTS o_agent_trace_id_unique ON public.o_agent_trace USING btree (id);
CREATE INDEX IF NOT EXISTS o_agent_trace_projectid_createtime_index ON public.o_agent_trace USING btree ("projectId", "createTime");
CREATE UNIQUE INDEX IF NOT EXISTS o_artstyle_id_unique ON public."o_artStyle" USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_chapter_arc_id_unique ON public.o_chapter_arc USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_chapter_arc_projectid_volumeid_arcindex_unique ON public.o_chapter_arc USING btree ("projectId", "volumeId", "arcIndex");
CREATE INDEX IF NOT EXISTS o_chapter_arc_projectid_volumeid_index ON public.o_chapter_arc USING btree ("projectId", "volumeId");
CREATE UNIQUE INDEX IF NOT EXISTS o_chapter_plan_id_unique ON public.o_chapter_plan USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_chapter_plan_projectid_chapterindex_unique ON public.o_chapter_plan USING btree ("projectId", "chapterIndex");
CREATE INDEX IF NOT EXISTS o_chapter_plan_projectid_volumeid_index ON public.o_chapter_plan USING btree ("projectId", "volumeId");
CREATE UNIQUE INDEX IF NOT EXISTS o_chapter_version_id_unique ON public.o_chapter_version USING btree (id);
CREATE INDEX IF NOT EXISTS o_chapter_version_novelid_createtime_index ON public.o_chapter_version USING btree ("novelId", "createTime");
CREATE INDEX IF NOT EXISTS o_chathistory_projectid_agentkey_createtime_index ON public."o_chatHistory" USING btree ("projectId", "agentKey", "createTime");
CREATE UNIQUE INDEX IF NOT EXISTS o_check_report_id_unique ON public.o_check_report USING btree (id);
CREATE INDEX IF NOT EXISTS o_check_report_projectid_createtime_index ON public.o_check_report USING btree ("projectId", "createTime");
CREATE UNIQUE INDEX IF NOT EXISTS o_content_audit_id_unique ON public.o_content_audit USING btree (id);
CREATE INDEX IF NOT EXISTS o_content_audit_projectid_createtime_index ON public.o_content_audit USING btree ("projectId", "createTime");
CREATE UNIQUE INDEX IF NOT EXISTS o_foreshadow_id_unique ON public.o_foreshadow USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_foreshadow_projectid_fskey_unique ON public.o_foreshadow USING btree ("projectId", "fsKey");
CREATE UNIQUE INDEX IF NOT EXISTS o_ledger_snapshot_id_unique ON public.o_ledger_snapshot USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_ledger_snapshot_projectid_chapterindex_unique ON public.o_ledger_snapshot USING btree ("projectId", "chapterIndex");
CREATE UNIQUE INDEX IF NOT EXISTS o_market_book_gene_bookid_snapshotdate_unique ON public.o_market_book_gene USING btree ("bookId", "snapshotDate");
CREATE INDEX IF NOT EXISTS idx_market_rank_tags_gin ON public.o_market_rank_snapshot USING gin (tags);
CREATE INDEX IF NOT EXISTS o_market_rank_snapshot_bookid_snapshotdate_index ON public.o_market_rank_snapshot USING btree ("bookId", "snapshotDate");
CREATE INDEX IF NOT EXISTS o_market_rank_snapshot_category_gender_ranktype_snapshotdate_in ON public.o_market_rank_snapshot USING btree (category, gender, "rankType", "snapshotDate");
CREATE UNIQUE INDEX IF NOT EXISTS o_market_rank_snapshot_snapshotdate_platform_ranktype_gender_ca ON public.o_market_rank_snapshot USING btree ("snapshotDate", platform, "rankType", gender, category, "bookId");
CREATE INDEX IF NOT EXISTS o_market_rank_snapshot_snapshotdate_ranktype_index ON public.o_market_rank_snapshot USING btree ("snapshotDate", "rankType");
CREATE UNIQUE INDEX IF NOT EXISTS o_market_schedule_log_id_unique ON public.o_market_schedule_log USING btree (id);
CREATE INDEX IF NOT EXISTS o_market_schedule_log_tasktype_weekstart_index ON public.o_market_schedule_log USING btree ("taskType", "weekStart");
CREATE INDEX IF NOT EXISTS o_market_topic_growthrate7d_index ON public.o_market_topic USING btree ("growthRate7d");
CREATE INDEX IF NOT EXISTS o_market_topic_lifecycle_index ON public.o_market_topic USING btree (lifecycle);
CREATE INDEX IF NOT EXISTS o_market_topic_parenttopic_topictype_index ON public.o_market_topic USING btree ("parentTopic", "topicType");
CREATE UNIQUE INDEX IF NOT EXISTS o_market_topic_topicname_gender_category_topictype_unique ON public.o_market_topic USING btree ("topicName", gender, category, "topicType");
CREATE UNIQUE INDEX IF NOT EXISTS o_market_topic_pool_id_unique ON public.o_market_topic_pool USING btree (id);
CREATE INDEX IF NOT EXISTS o_market_topic_pool_reportid_index ON public.o_market_topic_pool USING btree ("reportId");
CREATE UNIQUE INDEX IF NOT EXISTS o_market_weekly_report_id_unique ON public.o_market_weekly_report USING btree (id);
CREATE INDEX IF NOT EXISTS o_market_weekly_report_status_index ON public.o_market_weekly_report USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS o_market_weekly_report_weekstart_unique ON public.o_market_weekly_report USING btree ("weekStart");
CREATE UNIQUE INDEX IF NOT EXISTS o_modelprompt_id_unique ON public."o_modelPrompt" USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_novel_id_unique ON public.o_novel USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_novel_projectid_chapterindex_unique ON public.o_novel USING btree ("projectId", "chapterIndex");
CREATE UNIQUE INDEX IF NOT EXISTS o_order_id_unique ON public.o_order USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_order_orderno_unique ON public.o_order USING btree ("orderNo");
CREATE INDEX IF NOT EXISTS o_order_userid_createtime_index ON public.o_order USING btree ("userId", "createTime");
CREATE UNIQUE INDEX IF NOT EXISTS o_plan_id_unique ON public.o_plan USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_project_id_unique ON public.o_project USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_prompt_id_unique ON public.o_prompt USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_setting_key_unique ON public.o_setting USING btree (key);
CREATE INDEX IF NOT EXISTS o_skillattribution_attribution_index ON public."o_skillAttribution" USING btree (attribution);
CREATE UNIQUE INDEX IF NOT EXISTS o_subscription_id_unique ON public.o_subscription USING btree (id);
CREATE INDEX IF NOT EXISTS o_subscription_userid_periodend_index ON public.o_subscription USING btree ("userId", "periodEnd");
CREATE UNIQUE INDEX IF NOT EXISTS o_tasks_id_unique ON public.o_tasks USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_user_id_unique ON public.o_user USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_vendorconfig_id_unique ON public."o_vendorConfig" USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_volume_id_unique ON public.o_volume USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS o_volume_projectid_volumeindex_unique ON public.o_volume USING btree ("projectId", "volumeIndex");
