export const CAPABILITY_PACK_NAMES = [
  "browse",
  "manual_control",
  "transcript",
  "public_social",
  "adaptive_comment",
  "messages",
  "notifications",
  "creator_comments",
  "publisher",
  "maintenance",
] as const;

export type CapabilityPackName = typeof CAPABILITY_PACK_NAMES[number];

export type CapabilityPackDefinition = {
  name: CapabilityPackName;
  title: string;
  description: string;
  dependencies: CapabilityPackName[];
  tools: string[];
};

export const CORE_TOOL_NAMES = new Set([
  "douyin_get_setup_status",
  "douyin_detect_current_account",
  "douyin_configure_initial_setup",
  "douyin_validate_setup",
  "douyin_status",
  "douyin_healthcheck",
  "douyin_startup_self_check",
  "douyin_list_capability_packs",
  "douyin_load_capability_pack",
  "douyin_unload_capability_pack",
  "douyin_capability_pack_status",
  "douyin_invoke_capability",
  "douyin_call_capability_tool",
  "douyin_call_write_capability_tool",
  "douyin_load_capability_pack_v1_9_1",
  "douyin_unload_capability_pack_v1_9_1",
  "douyin_call_capability_tool_v1_9_1",
  "douyin_call_write_capability_tool_v1_9_1",
  "douyin_load_capability_pack_v1_10_0",
  "douyin_unload_capability_pack_v1_10_0",
  "douyin_call_capability_tool_v1_10_0",
  "douyin_call_write_capability_tool_v1_10_0",
]);

export const CAPABILITY_PACKS: Record<CapabilityPackName, CapabilityPackDefinition> = {
  browse: {
    name: "browse",
    title: "浏览与内容理解",
    description: "刷推荐、打开作品、观察和滚动页面、理解视频图文、读取公开评论与作品上下文。",
    dependencies: [],
    tools: [
      "douyin_open_link",
      "douyin_extract_article",
      "douyin_probe_content",
      "douyin_read_current_gallery",
      "douyin_resolve_video",
      "douyin_understand_current",
      "douyin_read_chapters",
      "douyin_observe",
      "douyin_observe_fast",
      "douyin_open_section",
      "douyin_scroll",
      "douyin_scroll_region",
      "douyin_read_region",
      "douyin_click",
      "douyin_toggle_play",
      "douyin_inspect_video",
      "douyin_inspect_timeline",
      "douyin_back",
      "douyin_wait",
      "douyin_get_bound_user",
      "douyin_list_profile_recommendations",
      "douyin_list_bound_user_posts",
      "douyin_open_bound_user_post",
      "douyin_open_latest_bound_user_post",
      "douyin_get_current_work_context",
      "douyin_open_profile_recommendation",
      "douyin_open_next_profile_recommendation",
      "douyin_search_content",
      "douyin_list_current_feed",
      "douyin_open_feed_item",
      "douyin_next_video",
      "douyin_previous_video",
      "douyin_read_comments",
      "douyin_read_comment_thread",
    ],
  },
  manual_control: {
    name: "manual_control",
    title: "视觉手动控制",
    description: "基于冻结观察快照探测未知控件；视觉点击是显式写工具，只允许已绑定发布页的关闭弹窗、选音乐、预览和确认发布，并保留原发布门禁。",
    dependencies: ["browse"],
    tools: [
      "douyin_probe_visual_point",
      "douyin_click_visual_interface",
    ],
  },
  transcript: {
    name: "transcript",
    title: "本地字幕",
    description: "本地 faster-whisper 转写、按链接转写、字幕读取和搜索。",
    dependencies: ["browse"],
    tools: [
      "douyin_transcribe_current",
      "douyin_transcribe_link_local",
      "douyin_read_transcript",
      "douyin_search_transcript",
      "douyin_list_transcripts",
    ],
  },
  public_social: {
    name: "public_social",
    title: "公开互动",
    description: "在公开作品中点赞、收藏、关注、发表评论、回复精确评论，以及操作绑定用户作品。",
    dependencies: ["browse"],
    tools: [
      "douyin_like_post",
      "douyin_favorite_post",
      "douyin_follow_post_author",
      "douyin_like_current",
      "douyin_favorite_current",
      "douyin_follow_current_author",
      "douyin_like_bound_user_post",
      "douyin_comment_bound_user_post",
      "douyin_reply_comment_on_bound_user_post",
      "douyin_probe_comment_composer",
      "douyin_prepare_comment_on_post",
      "douyin_commit_comment_on_post",
      "douyin_prepare_reply_to_comment",
      "douyin_commit_reply_to_comment",
      "douyin_list_safe_social_actions",
      "douyin_click_safe_social_action",
      "douyin_comment_current",
      "douyin_reply_comment",
      "douyin_like_comment",
      "douyin_unlike_comment",
    ],
  },
  adaptive_comment: {
    name: "adaptive_comment",
    title: "评论事务自愈",
    description: "主评论标准点击严格无效后，在冻结账号、作品和文案内检查、重新触发输入、有限尝试鼠标或按键提交，并持久审计与精确回读。",
    dependencies: ["public_social"],
    tools: [
      "douyin_diagnose_root_comment_submit",
      "douyin_readback_exact_root_comment",
      "douyin_preview_comment_on_post",
      "douyin_adaptive_inspect_comment_composer",
      "douyin_adaptive_clear_and_fill_comment",
      "douyin_adaptive_inspect_submit_candidates",
      "douyin_adaptive_click_submit_candidate",
      "douyin_adaptive_press_comment_submit_key",
      "douyin_adaptive_observe_submit_effect",
      "douyin_adaptive_readback_exact_root_comment",
      "douyin_adaptive_get_audit",
    ],
  },
  messages: {
    name: "messages",
    title: "绑定私信",
    description: "只处理已绑定的 bound_user/Bound User 会话、分享和消息媒体。",
    dependencies: ["browse"],
    tools: [
      "douyin_share_current_to_bound_user",
      "douyin_list_messages_from_bound_user",
      "douyin_open_message_from_bound_user",
      "douyin_open_message_media_from_bound_user",
      "douyin_list_message_media_queue_from_bound_user",
      "douyin_check_bound_user_updates",
      "douyin_list_all_message_media_from_bound_user",
      "douyin_open_next_message_media_from_bound_user",
      "douyin_open_next_unseen_media_from_bound_user",
      "douyin_check_bound_user_updates_and_watch_all",
      "douyin_open_bound_user_conversation_fullscreen",
      "douyin_return_to_bound_user_conversation",
      "douyin_reply_to_bound_user",
      "douyin_reply_to_bound_user_media",
    ],
  },
  notifications: {
    name: "notifications",
    title: "通知中心与精确回复准备",
    description: "只读解析通知中心，并将稳定 notice_id 精确冻结到作品或评论；回复仅 prepare，不自动 commit。",
    dependencies: ["browse"],
    tools: [
      "douyin_list_notifications",
      "douyin_check_notification_updates",
      "douyin_ack_notification_checkpoint",
      "douyin_get_notification",
      "douyin_open_notification_target",
      "douyin_prepare_reply_from_notification",
    ],
  },
  creator_comments: {
    name: "creator_comments",
    title: "自有作品评论管理",
    description: "通过创作者中心读取、查找和回复 Operator 自有作品下的评论。",
    dependencies: [],
    tools: [
      "douyin_list_own_posts",
      "douyin_open_own_post",
      "douyin_read_own_post_comments",
      "douyin_check_own_comment_updates",
      "douyin_creator_verify_account",
      "douyin_creator_open_comment_manager",
      "douyin_creator_list_comments",
      "douyin_creator_read_current_filtered_comments",
      "douyin_creator_find_comments",
      "douyin_creator_open_comment_by_id",
      "douyin_creator_scan_comments",
      "douyin_creator_prepare_reply_from_match",
      "douyin_creator_prepare_reply",
      "douyin_creator_commit_reply",
      "douyin_creator_get_reply_status",
      "douyin_creator_reply_comment",
      "douyin_creator_comment_on_own_post",
      "douyin_creator_prepare_delete_comment",
      "douyin_creator_commit_delete_comment",
      "douyin_creator_get_delete_comment_status",
      "douyin_creator_check_comment_updates",
      "douyin_read_own_work_comments",
      "douyin_list_unread_comments",
    ],
  },
  publisher: {
    name: "publisher",
    title: "创作与发布",
    description: "通过统一编排器准备、发布、核验和恢复作品。",
    dependencies: ["browse"],
    tools: [
      "douyin_publish_content",
      "douyin_get_publish_status",
      "douyin_recover_publish",
      "douyin_list_publish_operations",
      "douyin_probe_visual_point",
      "douyin_click_visual_interface",
    ],
  },
  maintenance: {
    name: "maintenance",
    title: "绑定、诊断与事务恢复",
    description: "页面绑定、浏览器标签、审计日志、无发送恢复和未决事务回查。",
    dependencies: [],
    tools: [
      "browser_list_allowed_tabs",
      "douyin_bind_page",
      "browser_switch_allowed_tab",
      "douyin_abort_comment_operation",
      "douyin_archive_unresolved_comment_operation",
      "douyin_reconcile_reply_operations",
      "douyin_read_action_log",
      "douyin_list_notifications",
      "douyin_check_notification_updates",
      "douyin_get_notification",
      "douyin_open_notification_target",
    ],
  },
};

// Kept registered temporarily for rollback and direct fixture coverage only.
// These tools are absent from tools/list and both capability gateways.
export const INTERNAL_PUBLISHER_TOOL_NAMES = new Set([
  "douyin_create_post_draft", "douyin_get_post_draft", "douyin_list_post_drafts",
  "douyin_add_post_images", "douyin_insert_post_image", "douyin_reorder_post_images",
  "douyin_replace_post_image", "douyin_remove_post_image", "douyin_set_post_caption",
  "douyin_get_post_caption", "douyin_set_post_cover_index", "douyin_get_post_cover_index",
  "douyin_open_music_picker", "douyin_close_music_picker", "douyin_debug_music_picker",
  "douyin_get_selected_music", "douyin_preview_post", "douyin_publish_post",
  "douyin_upload_article_cover", "douyin_select_article_cover", "douyin_verify_article_cover",
  "douyin_remove_article_cover", "douyin_inspect_current_draft", "douyin_fill_text_draft",
  "douyin_preview_text_draft", "douyin_publish_text_draft", "douyin_verify_text_publish",
  "douyin_reset_current_draft", "douyin_list_recommended_music", "douyin_search_music",
  "douyin_preview_music", "douyin_select_music", "douyin_remove_music", "douyin_verify_music",
  "douyin_render_html_carousel", "douyin_publish_text", "douyin_publish_carousel",
  "douyin_publish_video", "douyin_publish_article",
]);

export function expandCapabilityPacks(
  requested: Iterable<CapabilityPackName>,
): Set<CapabilityPackName> {
  const expanded = new Set<CapabilityPackName>();
  const visit = (name: CapabilityPackName): void => {
    if (expanded.has(name)) return;
    expanded.add(name);
    for (const dependency of CAPABILITY_PACKS[name].dependencies) visit(dependency);
  };
  for (const name of requested) visit(name);
  return expanded;
}

export function packsForTool(toolName: string): CapabilityPackName[] {
  return CAPABILITY_PACK_NAMES.filter(name =>
    CAPABILITY_PACKS[name].tools.includes(toolName));
}
