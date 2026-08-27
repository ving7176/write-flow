// @db-hash ca0f38b5c2de2a46edfb491a0596251c
//该文件由脚本自动生成，请勿手动修改

export interface memories {
  'content': string;
  'createTime': number;
  'embedding'?: string | null;
  'id': string;
  'isolationKey': string;
  'name'?: string | null;
  'relatedMessageIds'?: string | null;
  'role'?: string | null;
  'summarized'?: number | null;
  'type': string;
}
export interface o_agent_trace {
  'agentKey'?: string | null;
  'createTime'?: number | null;
  'detail'?: string | null;
  'durationMs'?: number | null;
  'event'?: string | null;
  'gate'?: string | null;
  'id': number;
  'projectId'?: number | null;
  'retryCount'?: number | null;
  'schemaValid'?: string | null;
  'stage'?: string | null;
}
export interface o_agentDeploy {
  'desc'?: string | null;
  'disabled'?: boolean | null;
  'id'?: number;
  'key'?: string | null;
  'maxOutputTokens'?: number | null;
  'model'?: string | null;
  'modelName'?: string | null;
  'name'?: string | null;
  'temperature'?: number | null;
  'type'?: string | null;
  'vendorId'?: string | null;
}
export interface o_agentWorkData {
  'createTime'?: number | null;
  'data'?: string | null;
  'episodesId'?: number | null;
  'id'?: number;
  'key'?: string | null;
  'projectId'?: number | null;
  'updateTime'?: number | null;
}
export interface o_artStyle {
  'fileUrl'?: string | null;
  'id'?: number;
  'label'?: string | null;
  'name'?: string | null;
  'prompt'?: string | null;
}
export interface o_chapter_arc {
  'arcIndex'?: number | null;
  'contribution'?: string | null;
  'createTime'?: number | null;
  'endChapter'?: number | null;
  'id': number;
  'projectId'?: number | null;
  'startChapter'?: number | null;
  'title'?: string | null;
  'updateTime'?: number | null;
  'volumeId'?: number | null;
}
export interface o_chapter_plan {
  'arcId'?: number | null;
  'bookmarked'?: number | null;
  'chapterIndex'?: number | null;
  'coolPoints'?: string | null;
  'createTime'?: number | null;
  'foreshadowRefs'?: string | null;
  'hooks'?: string | null;
  'id': number;
  'projectId'?: number | null;
  'sortOrder'?: number | null;
  'status'?: string | null;
  'summary'?: string | null;
  'title'?: string | null;
  'updateTime'?: number | null;
  'volumeId'?: number | null;
  'wordTarget'?: number | null;
}
export interface o_chapter_version {
  'chapter'?: string | null;
  'chapterData'?: string | null;
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'id': number;
  'novelId'?: number | null;
  'projectId'?: number | null;
  'source'?: string | null;
  'version'?: number | null;
}
export interface o_chatHistory {
  'agentKey': string;
  'content': string;
  'createTime': number;
  'id': string;
  'name'?: string | null;
  'projectId'?: number | null;
  'role'?: string | null;
  'stageKey'?: string | null;
}
export interface o_check_report {
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'detailMd'?: string | null;
  'id': number;
  'issues'?: string | null;
  'metrics'?: string | null;
  'projectId'?: number | null;
  'rating'?: string | null;
  'reportType'?: string | null;
  'stageKey'?: string | null;
  'summary'?: string | null;
}
export interface o_content_audit {
  'contentSnapshot'?: string | null;
  'createTime'?: number | null;
  'handler'?: string | null;
  'id': number;
  'label'?: string | null;
  'projectId'?: number | null;
  'result'?: string | null;
  'score'?: number | null;
  'sourceKey'?: string | null;
  'sourceType'?: string | null;
}
export interface o_foreshadow {
  'createTime'?: number | null;
  'description'?: string | null;
  'fsKey'?: string | null;
  'id': number;
  'plannedResolveChapterIndex'?: number | null;
  'plantedChapterIndex'?: number | null;
  'projectId'?: number | null;
  'resolvedChapterIndex'?: number | null;
  'source'?: string | null;
  'status'?: string | null;
  'updateTime'?: number | null;
}
export interface o_ledger_snapshot {
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'data'?: string | null;
  'id': number;
  'projectId'?: number | null;
}
export interface o_market_book_gene {
  'bookId': string;
  'bookName'?: string | null;
  'createTime'?: number | null;
  'geneJson'?: string | null;
  'id': number;
  'modelName'?: string | null;
  'snapshotDate'?: Date | null;
}
export interface o_market_rank_snapshot {
  'author'?: string | null;
  'authorId'?: string | null;
  'bookId': string;
  'bookName'?: string | null;
  'category': string;
  'chapterCount'?: number | null;
  'createTime'?: number | null;
  'gender': string;
  'heatText'?: string | null;
  'heatValue'?: number | null;
  'id': number;
  'intro'?: string | null;
  'latestChapter'?: string | null;
  'latestUpdateTime'?: number | null;
  'platform'?: string | null;
  'rank'?: number | null;
  'rankChange'?: number | null;
  'rankType': string;
  'snapshotDate': Date;
  'sourceUrl'?: string | null;
  'status'?: string | null;
  'tags'?: string[] | null;
  'wordCount'?: number | null;
}
export interface o_market_schedule_log {
  'createTime'?: number | null;
  'detail'?: string | null;
  'id': number;
  'status'?: string | null;
  'taskType'?: string | null;
  'weekStart'?: number | null;
}
export interface o_market_topic {
  'adaptationScore'?: number | null;
  'adaptationTier'?: string | null;
  'avgHeatValue'?: number | null;
  'avgWordCount'?: number | null;
  'category'?: string | null;
  'daysOnRank'?: number | null;
  'firstSeenDate'?: Date | null;
  'gender'?: string | null;
  'growthRate7d'?: string | null;
  'id': number;
  'lifecycle'?: string | null;
  'newbookCount7d'?: number | null;
  'parentTopic'?: string | null;
  'sampleBookIds'?: string[] | null;
  'topicName': string;
  'topicType'?: string;
  'updateTime'?: number | null;
}
export interface o_market_topic_pool {
  'avgHeat'?: number | null;
  'category'?: string | null;
  'createTime'?: number | null;
  'gender'?: string | null;
  'geneJson'?: string | null;
  'growthRate'?: string | null;
  'id': number;
  'lifecycle'?: string | null;
  'oneLineTemplate'?: string | null;
  'projectId'?: number | null;
  'reason'?: string | null;
  'reportId'?: number | null;
  'sampleBooks'?: string | null;
  'topicName'?: string | null;
}
export interface o_market_weekly_report {
  'createTime'?: number | null;
  'directionJson'?: string | null;
  'errorMsg'?: string | null;
  'id': number;
  'reasonJson'?: string | null;
  'reportMd'?: string | null;
  'status'?: string | null;
  'trendJson'?: string | null;
  'weekLabel'?: string | null;
  'weekStart'?: number | null;
}
export interface o_modelPrompt {
  'fileName'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'path'?: string | null;
  'vendorId'?: string | null;
}
export interface o_novel {
  'chapter'?: string | null;
  'chapterData'?: string | null;
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'reel'?: string | null;
  'volumeId'?: number | null;
}
export interface o_novel_blueprint {
  'charactersDraft'?: string | null;
  'createTime'?: number | null;
  'eventRhythm'?: string | null;
  'genre'?: string | null;
  'id': number;
  'name'?: string | null;
  'sourceProjectId'?: number | null;
  'userId'?: number | null;
  'volumePlan'?: string | null;
}
export interface o_novel_embedding {
  'chapterIndex'?: number | null;
  'chunkIndex'?: number | null;
  'chunkText'?: string | null;
  'createTime'?: number | null;
  'embedding'?: string | null;
  'id': number;
  'novelId'?: number | null;
  'projectId'?: number | null;
}
export interface o_order {
  'amount'?: number | null;
  'channel'?: string | null;
  'createTime'?: number | null;
  'id': number;
  'orderNo': string;
  'payTime'?: number | null;
  'planId'?: string | null;
  'status'?: string | null;
  'tradeNo'?: string | null;
  'userId'?: number | null;
}
export interface o_plan {
  'createTime'?: number | null;
  'featureFlags'?: string | null;
  'id': string;
  'name'?: string | null;
  'price'?: number | null;
  'status'?: string | null;
  'tokensPerMonth'?: number | null;
}
export interface o_project {
  'artStyle'?: string | null;
  'createTime'?: number | null;
  'deletedAt'?: number | null;
  'directorManual'?: string | null;
  'id': number;
  'imageModel'?: string | null;
  'imageQuality'?: string | null;
  'intro'?: string | null;
  'name'?: string | null;
  'projectType'?: string | null;
  'seriesId'?: number | null;
  'shareToken'?: string | null;
  'status'?: string | null;
  'type'?: string | null;
  'userId'?: number | null;
}
export interface o_project_member {
  'createTime'?: number | null;
  'id': number;
  'projectId'?: number | null;
  'role'?: string | null;
  'userId'?: number | null;
}
export interface o_prompt {
  'data'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'type'?: string | null;
  'useData'?: string | null;
}
export interface o_push_subscription {
  'auth'?: string | null;
  'createTime'?: number | null;
  'endpoint'?: string | null;
  'id': number;
  'p256dh'?: string | null;
  'userId'?: number | null;
}
export interface o_series {
  'createTime'?: number | null;
  'id': number;
  'intro'?: string | null;
  'name'?: string | null;
  'userId'?: number | null;
}
export interface o_series_setting {
  'content'?: string | null;
  'id': number;
  'seriesId'?: number | null;
  'stageKey'?: string | null;
  'updateTime'?: number | null;
}
export interface o_setting {
  'key': string;
  'value'?: string | null;
}
export interface o_skillAttribution {
  'attribution': string;
  'skillId': string;
}
export interface o_skillList {
  'createTime': number;
  'description': string;
  'embedding'?: string | null;
  'id': string;
  'md5': string;
  'name': string;
  'path': string;
  'state': number;
  'type': string;
  'updateTime': number;
}
export interface o_stage_version {
  'content'?: string | null;
  'createTime'?: number | null;
  'id': number;
  'projectId'?: number | null;
  'source'?: string | null;
  'stageKey'?: string | null;
}
export interface o_subscription {
  'id': number;
  'periodEnd'?: number | null;
  'periodStart'?: number | null;
  'planId'?: string | null;
  'status'?: string | null;
  'tokensUsed'?: number | null;
  'userId': number;
}
export interface o_tasks {
  'completionTokens'?: number | null;
  'cost'?: number | null;
  'describe'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'projectId'?: number | null;
  'promptTokens'?: number | null;
  'reason'?: string | null;
  'relatedObjects'?: string | null;
  'startTime'?: number | null;
  'state'?: string | null;
  'taskClass'?: string | null;
  'totalTokens'?: number | null;
}
export interface o_user {
  'createTime'?: number | null;
  'email'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'password'?: string | null;
  'role'?: string | null;
  'status'?: string | null;
  'tokenVersion'?: number;
}
export interface o_user_audit {
  'action'?: string | null;
  'createTime'?: number | null;
  'detail'?: string | null;
  'id': number;
  'ip'?: string | null;
  'target'?: string | null;
  'userId'?: number | null;
}
export interface o_user_notice {
  'content'?: string | null;
  'createTime'?: number | null;
  'id': number;
  'readAt'?: number | null;
  'title'?: string | null;
  'type'?: string | null;
  'userId'?: number | null;
}
export interface o_user_pref {
  'key': string;
  'updateTime'?: number | null;
  'userId': number;
  'value'?: string | null;
}
export interface o_vendorConfig {
  'enable'?: number | null;
  'id': string;
  'inputValues'?: string | null;
  'models'?: string | null;
}
export interface o_volume {
  'conflictScale'?: string | null;
  'createTime'?: number | null;
  'id': number;
  'mainline'?: string | null;
  'oneLineSummary'?: string | null;
  'plannedChapters'?: number | null;
  'projectId'?: number | null;
  'stageLabel'?: string | null;
  'status'?: string | null;
  'stories'?: string | null;
  'summary'?: string | null;
  'title'?: string | null;
  'updateTime'?: number | null;
  'volumeIndex'?: number | null;
}

export interface DB {
  "memories": memories;
  "o_agent_trace": o_agent_trace;
  "o_agentDeploy": o_agentDeploy;
  "o_agentWorkData": o_agentWorkData;
  "o_artStyle": o_artStyle;
  "o_chapter_arc": o_chapter_arc;
  "o_chapter_plan": o_chapter_plan;
  "o_chapter_version": o_chapter_version;
  "o_chatHistory": o_chatHistory;
  "o_check_report": o_check_report;
  "o_content_audit": o_content_audit;
  "o_foreshadow": o_foreshadow;
  "o_ledger_snapshot": o_ledger_snapshot;
  "o_market_book_gene": o_market_book_gene;
  "o_market_rank_snapshot": o_market_rank_snapshot;
  "o_market_schedule_log": o_market_schedule_log;
  "o_market_topic": o_market_topic;
  "o_market_topic_pool": o_market_topic_pool;
  "o_market_weekly_report": o_market_weekly_report;
  "o_modelPrompt": o_modelPrompt;
  "o_novel": o_novel;
  "o_novel_blueprint": o_novel_blueprint;
  "o_novel_embedding": o_novel_embedding;
  "o_order": o_order;
  "o_plan": o_plan;
  "o_project": o_project;
  "o_project_member": o_project_member;
  "o_prompt": o_prompt;
  "o_push_subscription": o_push_subscription;
  "o_series": o_series;
  "o_series_setting": o_series_setting;
  "o_setting": o_setting;
  "o_skillAttribution": o_skillAttribution;
  "o_skillList": o_skillList;
  "o_stage_version": o_stage_version;
  "o_subscription": o_subscription;
  "o_tasks": o_tasks;
  "o_user": o_user;
  "o_user_audit": o_user_audit;
  "o_user_notice": o_user_notice;
  "o_user_pref": o_user_pref;
  "o_vendorConfig": o_vendorConfig;
  "o_volume": o_volume;
}
