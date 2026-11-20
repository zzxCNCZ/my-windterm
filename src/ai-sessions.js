export class TerminalAiSessions {
  #nextNumber = 1;
  conversations = [];
  current = this.create();

  create() {
    const conversation = {
      number: this.#nextNumber++,
      turns: [],
      draft: '',
      includeContext: true,
      webSearch: true,
    };
    this.conversations.unshift(conversation);
    this.current = conversation;
    return conversation;
  }

  remove(conversation) {
    const index = this.conversations.indexOf(conversation);
    if (index < 0) return;
    this.conversations.splice(index, 1);
    if (this.current === conversation) {
      this.current = this.conversations[index] ?? this.conversations[index - 1] ?? this.create();
    }
  }

  clear() {
    this.conversations.length = 0;
    this.current = undefined;
  }
}
