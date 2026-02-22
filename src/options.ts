const OPT_DEFAULT_PROMPTS = [
    "翻譯以下文字: ",
    "Translate to English: ",
    "請總結這段文字: "
];

interface Gem {
    name: string;
    id: string;
}

let prompts: string[] = [];
let gems: Gem[] = [];

document.addEventListener('DOMContentLoaded', async () => {
    const data = await chrome.storage.sync.get(['prompts', 'gems']);
    prompts = data.prompts || OPT_DEFAULT_PROMPTS;
    gems = data.gems || [];

    renderPrompts();
    renderGems();

    document.getElementById('add-prompt-btn')?.addEventListener('click', addPrompt);
    document.getElementById('add-gem-btn')?.addEventListener('click', addGem);
    document.getElementById('save-btn')?.addEventListener('click', saveOptions);
});

function renderPrompts() {
    const list = document.getElementById('prompts-list');
    if (!list) return;
    list.innerHTML = '';

    prompts.forEach((prompt, index) => {
        const item = document.createElement('div');
        item.className = 'prompt-item';

        const input = document.createElement('textarea');
        input.value = prompt;
        input.addEventListener('change', (e) => {
            prompts[index] = (e.target as HTMLTextAreaElement).value;
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
            prompts.splice(index, 1);
            renderPrompts();
        });

        item.appendChild(input);
        item.appendChild(deleteBtn);
        list.appendChild(item);
    });
}

function renderGems() {
    const list = document.getElementById('gems-list');
    if (!list) return;
    list.innerHTML = '';

    gems.forEach((gem, index) => {
        const item = document.createElement('div');
        item.className = 'gem-item';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = gem.name;
        nameInput.addEventListener('change', (e) => {
            gems[index].name = (e.target as HTMLInputElement).value;
        });

        const idInput = document.createElement('input');
        idInput.type = 'text';
        idInput.value = gem.id;
        idInput.addEventListener('change', (e) => {
            gems[index].id = (e.target as HTMLInputElement).value;
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
            gems.splice(index, 1);
            renderGems();
        });

        item.appendChild(nameInput);
        item.appendChild(idInput);
        item.appendChild(deleteBtn);
        list.appendChild(item);
    });
}

function addPrompt() {
    const input = document.getElementById('new-prompt') as HTMLTextAreaElement;
    if (!input) return;
    const text = input.value.trim();
    if (text) {
        prompts.push(text);
        input.value = '';
        renderPrompts();
    }
}

function addGem() {
    const nameInput = document.getElementById('new-gem-name') as HTMLInputElement;
    const idInput = document.getElementById('new-gem-id') as HTMLInputElement;
    if (!nameInput || !idInput) return;

    const name = nameInput.value.trim();
    const id = idInput.value.trim();

    if (name && id) {
        gems.push({ name, id });
        nameInput.value = '';
        idInput.value = '';
        renderGems();
    }
}

async function saveOptions() {
    const validPrompts = prompts.filter(p => p.trim() !== '');
    const validGems = gems.filter(g => g.name.trim() !== '' && g.id.trim() !== '');

    await chrome.storage.sync.set({
        prompts: validPrompts,
        gems: validGems
    });

    const status = document.getElementById('status');
    if (status) {
        status.textContent = 'Options saved!';
        setTimeout(() => {
            status.textContent = '';
        }, 2000);
    }
}
