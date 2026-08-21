export interface ConversationDataEntry {
	namespace: string;
	key: string;
	value: string;
}

export interface ConversationVariantSnapshot {
	id: number;
	position: number;
	content: string;
	selected: boolean;
	data: ConversationDataEntry[];
}

export interface ConversationMessageSnapshot {
	id: number;
	position: number;
	timestamp: string;
	variants: ConversationVariantSnapshot[];
	data: ConversationDataEntry[];
}

export interface ConversationSnapshot {
	id: number;
	name: string;
	revision: number;
	characterIds: number[];
	messages: ConversationMessageSnapshot[];
	data: ConversationDataEntry[];
}

export type ConversationDataScope =
	| { type: "conversation" }
	| { type: "message"; messageId: number }
	| { type: "variant"; messageId: number; variantId: number };

export type ConversationAction =
	| {
			type: "create-message";
			timestamp: string;
			variantContents: readonly string[];
			selectedVariantIndex?: number;
	  }
	| { type: "create-variant"; messageId: number; content: string }
	| { type: "select-variant"; messageId: number; variantId: number }
	| { type: "edit-variant"; messageId: number; variantId: number; content: string }
	| { type: "delete-variant"; messageId: number; variantId: number }
	| { type: "delete-message"; messageId: number }
	| {
			type: "put-data";
			scope: ConversationDataScope;
			namespace: string;
			key: string;
			value: string;
	  }
	| {
			type: "delete-data";
			scope: ConversationDataScope;
			namespace: string;
			key: string;
	  };

export interface ConversationCommand {
	conversationId: number;
	expectedRevision: number;
	action: ConversationAction;
}

export interface ConversationModule {
	getSnapshot(conversationId: number): ConversationSnapshot | undefined;
	execute(command: ConversationCommand): ConversationSnapshot;
}
