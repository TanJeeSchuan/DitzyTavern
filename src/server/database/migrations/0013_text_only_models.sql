CREATE TABLE `connection_profile_text_only_model` (
	`profile_id` integer NOT NULL,
	`model_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `model_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
