-- Memory recall traces written before recall stored references kept each candidate's claim, attribution, people and
-- evidence. The trace schema closed over those fields, so forking a Chat with such a trace failed; drop them.
UPDATE `message_variant_data` AS `d` SET `value` = json_set(`d`.`value`, '$."box:memory".trace.candidates', (
	SELECT json_group_array(json(json_remove(`c`.`value`, '$.claim', '$.attribution', '$.people', '$.evidence')) ORDER BY `c`.`key`)
	FROM json_each(`d`.`value`, '$."box:memory".trace.candidates') AS `c`
))
WHERE `d`.`namespace` = 'generation-box' AND `d`.`key` = 'traces'
	AND EXISTS (SELECT 1 FROM json_each(`d`.`value`, '$."box:memory".trace.candidates') AS `c` WHERE json_type(`c`.`value`, '$.claim') IS NOT NULL);
