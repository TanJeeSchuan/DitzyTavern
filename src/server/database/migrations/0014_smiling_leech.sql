ALTER TABLE `image` ADD `orphaned_at` integer;
--> statement-breakpoint
DROP TRIGGER `image_reference_gc`;
--> statement-breakpoint
UPDATE `image` SET `orphaned_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE NOT EXISTS (SELECT 1 FROM `image_reference` WHERE `image_hash` = `image`.`hash`);
--> statement-breakpoint
CREATE TRIGGER `image_reference_orphan` AFTER DELETE ON `image_reference` BEGIN
	UPDATE `image` SET `orphaned_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE `hash` = OLD.`image_hash` AND NOT EXISTS (SELECT 1 FROM `image_reference` WHERE `image_hash` = OLD.`image_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `image_reference_adopt` AFTER INSERT ON `image_reference` BEGIN
	UPDATE `image` SET `orphaned_at` = NULL WHERE `hash` = NEW.`image_hash`;
END;
