-- QQ 农场助手 MySQL 初始化脚本
-- 用于空库首启建表；后续增量升级由 initMysql() 兜底迁移

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS `users` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    `password_hash` VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    `role` VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT 'user',
    `status` VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `username` (`username`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `accounts` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `uin` VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    `code` VARCHAR(512) COLLATE utf8mb4_unicode_ci DEFAULT '',
    `nick` VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `name` VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `platform` VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT 'qq',
    `running` TINYINT(1) DEFAULT '0',
    `status` VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT 'valid',
    `api_error_count` INT DEFAULT '0',
    `auth_data` JSON DEFAULT NULL,
    `username` VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `avatar` VARCHAR(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `last_login_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uin` (`uin`),
    KEY `idx_accounts_username` (`username`),
    CONSTRAINT `fk_accounts_username` FOREIGN KEY (`username`) REFERENCES `users` (`username`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `account_configs` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `account_id` INT NOT NULL,
    `account_mode` VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT 'main',
    `harvest_delay_min` INT DEFAULT 180,
    `harvest_delay_max` INT DEFAULT 300,
    `automation_farm` TINYINT(1) DEFAULT '1',
    `automation_farm_push` TINYINT(1) DEFAULT '1',
    `automation_land_upgrade` TINYINT(1) DEFAULT '1',
    `automation_friend` TINYINT(1) DEFAULT '1',
    `automation_friend_help_exp_limit` TINYINT(1) DEFAULT '1',
    `automation_friend_steal` TINYINT(1) DEFAULT '1',
    `automation_friend_help` TINYINT(1) DEFAULT '1',
    `automation_friend_bad` TINYINT(1) DEFAULT '0',
    `automation_task` TINYINT(1) DEFAULT '1',
    `automation_email` TINYINT(1) DEFAULT '1',
    `automation_fertilizer_gift` TINYINT(1) DEFAULT '0',
    `automation_fertilizer_buy` TINYINT(1) DEFAULT '0',
    `automation_free_gifts` TINYINT(1) DEFAULT '1',
    `automation_share_reward` TINYINT(1) DEFAULT '1',
    `automation_vip_gift` TINYINT(1) DEFAULT '1',
    `automation_month_card` TINYINT(1) DEFAULT '1',
    `automation_open_server_gift` TINYINT(1) DEFAULT '1',
    `automation_sell` TINYINT(1) DEFAULT '1',
    `automation_fertilizer` VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT 'none',
    `planting_strategy` VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT 'preferred',
    `preferred_seed_id` INT DEFAULT '0',
    `interval_farm` INT DEFAULT '30',
    `interval_friend` INT DEFAULT '60',
    `interval_farm_min` INT DEFAULT '30',
    `interval_farm_max` INT DEFAULT '120',
    `interval_friend_min` INT DEFAULT '60',
    `interval_friend_max` INT DEFAULT '180',
    `friend_quiet_hours_enabled` TINYINT(1) DEFAULT '0',
    `friend_quiet_hours_start` VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT '23:00',
    `friend_quiet_hours_end` VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT '07:00',
    `steal_filter_enabled` TINYINT(1) DEFAULT '0',
    `steal_filter_mode` VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT 'blacklist',
    `steal_friend_filter_enabled` TINYINT(1) DEFAULT '0',
    `steal_friend_filter_mode` VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT 'blacklist',
    `advanced_settings` JSON DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `account_id` (`account_id`),
    CONSTRAINT `account_configs_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `account_friend_blacklist` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `account_id` INT NOT NULL,
    `friend_id` VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    `friend_name` VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `idx_account_friend` (`account_id`, `friend_id`),
    CONSTRAINT `account_friend_blacklist_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `account_friend_steal_filter` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `account_id` INT NOT NULL,
    `friend_id` VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    `friend_name` VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `idx_acc_friend_sf` (`account_id`, `friend_id`),
    CONSTRAINT `account_friend_steal_filter_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `account_plant_filter` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `account_id` INT NOT NULL,
    `plant_id` INT NOT NULL,
    `plant_name` VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `idx_account_plant` (`account_id`, `plant_id`),
    CONSTRAINT `account_plant_filter_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cards` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    `batch_no` VARCHAR(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `batch_name` VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `type` VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
    `description` TEXT COLLATE utf8mb4_unicode_ci,
    `days` INT DEFAULT NULL,
    `source` VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
    `channel` VARCHAR(64) COLLATE utf8mb4_unicode_ci DEFAULT '',
    `note` TEXT COLLATE utf8mb4_unicode_ci,
    `created_by` VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `used_by` INT DEFAULT NULL,
    `used_at` DATETIME DEFAULT NULL,
    `enabled` TINYINT(1) DEFAULT '1',
    `expires_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `code` (`code`),
    KEY `idx_cards_batch_no` (`batch_no`),
    KEY `idx_cards_source_enabled` (`source`, `enabled`),
    KEY `idx_cards_created_by` (`created_by`),
    KEY `used_by` (`used_by`),
    CONSTRAINT `cards_ibfk_1` FOREIGN KEY (`used_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `card_operation_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `card_id` INT DEFAULT NULL,
    `card_code` VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    `action` VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    `operator` VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `target_username` VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `remark` VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `before_snapshot` JSON DEFAULT NULL,
    `after_snapshot` JSON DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_card_operation_logs_card_code` (`card_code`),
    KEY `idx_card_operation_logs_action_created` (`action`, `created_at`),
    KEY `idx_card_operation_logs_target_created` (`target_username`, `created_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `config_audit_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `account_id` INT NOT NULL,
    `old_config` JSON DEFAULT NULL,
    `new_config` JSON DEFAULT NULL,
    `changed_by` VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `changed_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_acc_changed` (`account_id`, `changed_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `daily_statistics` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `account_id` INT NOT NULL,
    `stat_date` DATE NOT NULL,
    `exp_earned` INT DEFAULT '0',
    `gold_earned` INT DEFAULT '0',
    `steal_count` INT DEFAULT '0',
    `help_count` INT DEFAULT '0',
    `plant_count` INT DEFAULT '0',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `idx_daily_acc_date` (`account_id`, `stat_date`),
    CONSTRAINT `daily_statistics_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `operation_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `account_id` INT NOT NULL,
    `action` VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    `result` VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `details` JSON DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_acc_created` (`account_id`, `created_at`),
    CONSTRAINT `operation_logs_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ui_settings` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `user_id` INT NOT NULL,
    `theme` VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT 'dark',
    `performance_mode` TINYINT(1) DEFAULT '0',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `user_id` (`user_id`),
    CONSTRAINT `ui_settings_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `system_logs` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `account_id` VARCHAR(50) NOT NULL COMMENT '账号ID',
    `level` VARCHAR(20) NOT NULL DEFAULT 'info' COMMENT '日志级别',
    `category` VARCHAR(50) NOT NULL COMMENT '日志分类',
    `text` TEXT NOT NULL COMMENT '日志内容',
    `meta_data` JSON DEFAULT NULL COMMENT '额外数据',
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
    INDEX `idx_account_level` (`account_id`, `level`),
    INDEX `idx_created_at` (`created_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = '系统全局执行日志表';

CREATE TABLE IF NOT EXISTS `announcements` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `title` VARCHAR(255) NOT NULL DEFAULT '',
    `version` VARCHAR(50) DEFAULT '',
    `publish_date` VARCHAR(50) DEFAULT '',
    `content` TEXT NOT NULL,
    `enabled` TINYINT(1) DEFAULT 1,
    `created_by` VARCHAR(100) DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `refresh_tokens` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `username` VARCHAR(100) NOT NULL,
    `token_hash` VARCHAR(64) NOT NULL UNIQUE,
    `expires_at` DATETIME NOT NULL,
    `user_agent` VARCHAR(512) DEFAULT '',
    `ip_address` VARCHAR(45) DEFAULT '',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_rt_username` (`username`),
    INDEX `idx_rt_expires` (`expires_at`),
    CONSTRAINT `fk_rt_username` FOREIGN KEY (`username`) REFERENCES `users`(`username`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stats_daily` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `record_date` DATE NOT NULL,
    `total_exp` INT DEFAULT 0,
    `total_gold` INT DEFAULT 0,
    `total_steal` INT DEFAULT 0,
    `total_help` INT DEFAULT 0,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_date` (`record_date`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `report_logs` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `account_id` VARCHAR(50) NOT NULL COMMENT '账号ID',
    `account_name` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '账号名称快照',
    `mode` VARCHAR(20) NOT NULL DEFAULT 'test' COMMENT '汇报类型: test/hourly/daily',
    `ok` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '发送是否成功',
    `channel` VARCHAR(50) NOT NULL DEFAULT '' COMMENT '推送渠道',
    `title` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '汇报标题',
    `content` MEDIUMTEXT COMMENT '汇报正文',
    `error_message` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '失败原因',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
    INDEX `idx_report_logs_account_time` (`account_id`, `created_at`),
    INDEX `idx_report_logs_mode_time` (`mode`, `created_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = '经营汇报发送历史';

SET FOREIGN_KEY_CHECKS = 1;
