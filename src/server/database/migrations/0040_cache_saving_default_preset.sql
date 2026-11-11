INSERT INTO `prompt_preset` (`name`, `is_default`) VALUES ('Default (cache-saving)', 0);--> statement-breakpoint
INSERT INTO `prompt_preset_block` (`preset_id`, `position`, `reference`, `enabled`, `role`, `name`, `content`)
SELECT (SELECT MAX(`id`) FROM `prompt_preset`), CASE WHEN b.`position` > b.`history_position` THEN b.`position` ELSE ROW_NUMBER() OVER (
	PARTITION BY b.`position` <= b.`history_position`
	ORDER BY b.`reference` IN ('lore', 'box:memory') AND b.`position` < b.`history_position`, b.`position`
) END, b.`reference`, b.`enabled`, b.`role`, b.`name`, b.`content`
FROM (
	SELECT d.*, COALESCE((
		SELECT MIN(h.`position`) FROM `prompt_preset_block` h WHERE h.`preset_id` = d.`preset_id` AND h.`reference` = 'history' AND h.`enabled` = 1
	), 0) AS `history_position`
	FROM `prompt_preset_block` d JOIN `prompt_preset` p ON p.`id` = d.`preset_id` WHERE p.`is_default` = 1
) b;
