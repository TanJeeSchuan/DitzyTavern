CREATE TABLE `box_image_grant` (
	`box_id` text NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`box_id`, `hash`),
	FOREIGN KEY (`hash`) REFERENCES `image`(`hash`) ON UPDATE no action ON DELETE cascade
);
