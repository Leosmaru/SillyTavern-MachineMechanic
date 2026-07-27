// ============================================================================
// Цели (Objective) — встроенный порт расширения SillyTavern-Objective.
//
// Значок 🎯 рядом с 🔧🎲🧠 открывает панель: вводишь цель — ИИ разбивает её на
// список задач и незаметно ведёт к ним по ходу ролеплея, периодически проверяя
// выполнение. Данные хранятся в chat_metadata.objective (совместимо со
// стандартным Objective), поэтому старые цели подхватываются.
//
// Все id в DOM с префиксом mmobj- — чтобы не конфликтовать со standalone-версией.
// ============================================================================

import { chat_metadata, saveSettingsDebounced, is_send_press, extension_prompt_types } from "../../../../script.js";
import { getContext, extension_settings, saveMetadataDebounced } from "../../../extensions.js";
import { substituteParams, eventSource, event_types, generateQuietPrompt } from "../../../../script.js";
import { waitUntilCondition } from "../../../utils.js";
import { is_group_generating, selected_group } from "../../../group-chats.js";
import { callGenericPopup, Popup, POPUP_TYPE } from "../../../popup.js";
import { SlashCommandParser } from "../../../slash-commands/SlashCommandParser.js";
import { SlashCommand } from "../../../slash-commands/SlashCommand.js";

const MODULE_NAME = "Objective";
const BTN_ID = "mm-objective-button";
const PANEL_ID = "mm-objective-panel";

let taskTree = null;
let currentChatId = "";
let currentObjective = null;
let currentTask = null;
let checkCounter = 0;
let generateCounter = 0;
let lastMessageWasSwipe = false;
let selectedCustomPrompt = "default";

const defaultPrompts = {
    "createTask": 'Ignore previous instructions. Please generate a numbered list of plain text tasks to complete an objective. The objective that you must make a numbered task list for is: "{{objective}}". The tasks created should take into account the character traits of {{char}}. These tasks may or may not involve {{user}} directly. Include the objective as the final task.\n\nThe list should be formatted using a number followed by a fullstop and the task on each line, e.g. "1. Take over the world". Include only the list in your reply.',
    "checkTaskCompleted": "Ignore previous instructions. Determine if this task is completed: [{{task}}]. To do this, examine the most recent messages. Your response must only contain either true or false, and nothing else. Example output: true",
    "currentTask": "Your current task is [{{task}}]. Balance existing roleplay with completing this task.",
};

let objectivePrompts = defaultPrompts;

//###############################//
//#       Task Management       #//
//###############################//

function getTaskById(taskId) {
    if (taskId == null) throw "Null task id";
    return getTaskByIdRecurse(taskId, taskTree);
}

function getTaskByIdRecurse(taskId, task) {
    if (task.id == taskId) return task;
    for (const childTask of task.children) {
        const foundTask = getTaskByIdRecurse(taskId, childTask);
        if (foundTask != null) return foundTask;
    }
    return null;
}

function substituteParamsPrompts(content, substituteGlobal) {
    content = content.replace(/{{objective}}/gi, currentObjective?.description ?? "");
    content = content.replace(/{{task}}/gi, currentTask?.description ?? "");
    content = content.replace(/{{parent}}/gi, currentTask?.parent?.description ?? "");
    if (substituteGlobal) content = substituteParams(content);
    return content;
}

// Quiet-генерация списка задач по цели. Вызывать редко.
async function generateTasks() {
    const prompt = substituteParamsPrompts(objectivePrompts.createTask, false);
    console.log("[Механик машин] Генерация задач для цели");
    toastr.info("Генерирую задачи для цели", "Подождите…");
    const taskResponse = await generateQuietPrompt(prompt, false, false);

    currentObjective.children = [];
    const numberedListPattern = /^\d+\./;

    for (const task of taskResponse.split("\n").map((x) => x.trim())) {
        if (task.match(numberedListPattern) != null) {
            currentObjective.addTask(task.replace(numberedListPattern, "").trim());
        }
    }
    updateUiTaskList();
    setCurrentTask();
    toastr.success(`Создано задач: ${currentObjective.children.length}`, "Готово!");
}

async function markTaskCompleted() {
    if (jQuery.isEmptyObject(currentTask)) {
        toastr.warning("Нет текущей задачи");
        return;
    }
    console.info(`[Objective] Пользователь отметил задачу '${currentTask.description}' выполненной.`);
    currentTask.completeTask();
}

// Quiet-генерация проверки, выполнена ли задача.
async function checkTaskCompleted() {
    if (jQuery.isEmptyObject(currentTask)) {
        console.warn("[Objective] Нет текущей задачи для проверки");
        return String(false);
    }

    try {
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 10000, 100);
        }
        await waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug("[Objective] Не дождались окончания генерации");
        return String(false);
    }

    const toast = toastr.info("Проверяю выполнение задачи.");
    const prompt = substituteParamsPrompts(objectivePrompts.checkTaskCompleted, false);
    const taskResponse = (await generateQuietPrompt(prompt, false, false)).toLowerCase();
    toastr.clear(toast);

    if (taskResponse.includes("true")) {
        console.info(`[Objective] ИИ определил задачу '${currentTask.description}' как выполненную.`);
        currentTask.completeTask();
        return String(true);
    } else if (!(taskResponse.includes("false"))) {
        console.warn(`[Objective] Ответ проверки не содержит true/false: ${taskResponse}`);
    }
    return String(false);
}

function getNextIncompleteTaskRecurse(task) {
    if (task.completed === false && task.children.length === 0 && task.parentId !== "") {
        return task;
    }
    for (const childTask of task.children) {
        if (childTask.completed === true) continue;
        const foundTask = getNextIncompleteTaskRecurse(childTask);
        if (foundTask != null) return foundTask;
    }
    return null;
}

// Установить текущую задачу в контекст (extensionPrompt). По умолчанию — первая невыполненная.
function setCurrentTask(taskId = null, skipSave = false) {
    const context = getContext();
    currentTask = {};

    if (taskId === null) {
        currentTask = getNextIncompleteTaskRecurse(taskTree) || {};
    } else {
        currentTask = getTaskById(taskId);
    }

    const description = currentTask.description || null;
    if (description) {
        const extensionPromptText = substituteParamsPrompts(objectivePrompts.currentTask, true);

        $(".objective-task").css({ "border-color": "", "border-width": "" });
        let highlightTask = currentTask;
        while (highlightTask.parentId !== "") {
            if (highlightTask.descriptionSpan) {
                highlightTask.descriptionSpan.css({ "border-color": "yellow", "border-width": "2px" });
            }
            const parent = getTaskById(highlightTask.parentId);
            highlightTask = parent;
        }

        context.setExtensionPrompt(MODULE_NAME, extensionPromptText, extension_prompt_types.IN_CHAT, Number($("#mmobj-chat-depth").val()));
    } else {
        context.setExtensionPrompt(MODULE_NAME, "", extension_prompt_types.NONE, 0);
    }

    if (!skipSave) saveState();
}

function getHighestTaskIdRecurse(task) {
    let nextId = task.id;
    for (const childTask of task.children) {
        const childId = getHighestTaskIdRecurse(childTask);
        if (childId > nextId) nextId = childId;
    }
    return nextId;
}

//###############################//
//#         Task Class          #//
//###############################//
class ObjectiveTask {
    id;
    description;
    completed;
    parentId;
    children;

    taskHtml;
    descriptionSpan;
    completedCheckbox;
    deleteTaskButton;
    addTaskButton;
    moveUpBotton;
    moveDownButton;

    constructor({ id = undefined, description, completed = false, parentId = "" }) {
        this.description = description;
        this.parentId = parentId;
        this.children = [];
        this.completed = completed;
        this.id = id == undefined ? getHighestTaskIdRecurse(taskTree) + 1 : id;
    }

    addTask(description, index = null) {
        index = index != null ? index : index = this.children.length;
        this.children.splice(index, 0, new ObjectiveTask({ description: description, parentId: this.id }));
        saveState();
    }

    getIndex() {
        if (this.parentId !== null) {
            const parent = getTaskById(this.parentId);
            const index = parent.children.findIndex((task) => task.id === this.id);
            if (index === -1) throw `getIndex failed: Task '${this.description}' not found in parent task '${parent.description}'`;
            return index;
        } else {
            throw `getIndex failed: Task '${this.description}' has no parent`;
        }
    }

    checkParentComplete() {
        let all_completed = true;
        if (this.parentId !== "") {
            const parent = getTaskById(this.parentId);
            for (const child of parent.children) {
                if (!child.completed) { all_completed = false; break; }
            }
            parent.completed = all_completed;
        }
    }

    completeTask() {
        this.completed = true;
        this.checkParentComplete();
        setCurrentTask();
        updateUiTaskList();
    }

    addUiElement() {
        const template = `
        <div id="mmobj-task-label-${this.id}" class="flex1 checkbox_label alignItemsCenter">
            <input id="mmobj-task-complete-${this.id}" type="checkbox">
            <span class="text_pole objective-task" style="display: block" id="mmobj-task-description-${this.id}" contenteditable>${this.description}</span>
            <div id="mmobj-task-delete-${this.id}" class="objective-task-button fa-solid fa-xmark fa-fw fa-lg" title="Удалить задачу"></div>
            <div id="mmobj-task-add-${this.id}" class="objective-task-button fa-solid fa-plus fa-fw fa-lg" title="Добавить задачу"></div>
            <div id="mmobj-task-add-branch-${this.id}" class="objective-task-button fa-solid fa-code-fork fa-fw fa-lg" title="Разбить на подзадачи"></div>
            <div id="mmobj-task-move-up-${this.id}" class="objective-task-button fa-solid fa-arrow-up fa-fw fa-lg" title="Вверх"></div>
            <div id="mmobj-task-move-down-${this.id}" class="objective-task-button fa-solid fa-arrow-down fa-fw fa-lg" title="Вниз"></div>
        </div><br>
        `;

        $("#mmobj-tasks").append(template);

        this.completedCheckbox = $(`#mmobj-task-complete-${this.id}`);
        this.descriptionSpan = $(`#mmobj-task-description-${this.id}`);
        this.addButton = $(`#mmobj-task-add-${this.id}`);
        this.deleteButton = $(`#mmobj-task-delete-${this.id}`);
        this.taskHtml = $(`#mmobj-task-label-${this.id}`);
        this.branchButton = $(`#mmobj-task-add-branch-${this.id}`);
        this.moveUpButton = $(`mmobj-task-move-up-${this.id}`);
        this.moveDownButton = $(`mmobj-task-move-down-${this.id}`);

        if (this.children.length > 0) {
            this.branchButton.css({ "color": "#33cc33" });
        } else {
            this.branchButton.css({ "color": "" });
        }

        const parent = getTaskById(this.parentId);
        if (parent) {
            let index = parent.children.indexOf(this);
            if (index < 1) {
                $(`#mmobj-task-move-up-${this.id}`).removeClass("fa-arrow-up");
            } else {
                $(`#mmobj-task-move-up-${this.id}`).addClass("fa-arrow-up");
                $(`#mmobj-task-move-up-${this.id}`).on("click", () => this.onMoveUpClick());
            }

            if (index === (parent.children.length - 1)) {
                $(`#mmobj-task-move-down-${this.id}`).removeClass("fa-arrow-down");
            } else {
                $(`#mmobj-task-move-down-${this.id}`).addClass("fa-arrow-down");
                $(`#mmobj-task-move-down-${this.id}`).on("click", () => this.onMoveDownClick());
            }
        }

        $(`#mmobj-task-complete-${this.id}`).prop("checked", this.completed);
        $(`#mmobj-task-complete-${this.id}`).on("click", () => this.onCompleteClick());
        $(`#mmobj-task-description-${this.id}`).on("keyup", () => this.onDescriptionUpdate());
        $(`#mmobj-task-description-${this.id}`).on("focusout", () => this.onDescriptionFocusout());
        $(`#mmobj-task-delete-${this.id}`).on("click", () => this.onDeleteClick());
        $(`#mmobj-task-add-${this.id}`).on("click", () => this.onAddClick());
        this.branchButton.on("click", () => this.onBranchClick());
    }

    onBranchClick() {
        currentObjective = this;
        updateUiTaskList();
        setCurrentTask();
    }

    complete(completed) {
        this.completed = completed;
        this.children.forEach((child) => child.complete(completed));
    }

    onCompleteClick() {
        this.complete(this.completedCheckbox.prop("checked"));
        this.checkParentComplete();
        setCurrentTask();
    }

    onDescriptionUpdate() {
        this.description = this.descriptionSpan.text();
    }

    onDescriptionFocusout() {
        setCurrentTask();
    }

    onDeleteClick() {
        const index = this.getIndex();
        const parent = getTaskById(this.parentId);
        parent.children.splice(index, 1);
        updateUiTaskList();
        setCurrentTask();
    }

    onMoveUpClick() {
        const parent = getTaskById(this.parentId);
        const index = parent.children.indexOf(this);
        if (index != 0) {
            let temp = parent.children[index - 1];
            parent.children[index - 1] = parent.children[index];
            parent.children[index] = temp;
            updateUiTaskList();
            if (currentTask) setCurrentTask(currentTask.taskId);
        }
    }

    onMoveDownClick() {
        const parent = getTaskById(this.parentId);
        const index = parent.children.indexOf(this);
        if (index < (parent.children.length - 1)) {
            let temp = parent.children[index + 1];
            parent.children[index + 1] = parent.children[index];
            parent.children[index] = temp;
            updateUiTaskList();
            setCurrentTask();
        }
    }

    onAddClick() {
        const index = this.getIndex();
        const parent = getTaskById(this.parentId);
        parent.addTask("", index + 1);
        updateUiTaskList();
        setCurrentTask();
    }

    toSaveStateRecurse() {
        let children = [];
        if (this.children.length > 0) {
            for (const child of this.children) children.push(child.toSaveStateRecurse());
        }
        return {
            "id": this.id,
            "description": this.description,
            "completed": this.completed,
            "parentId": this.parentId,
            "children": children,
        };
    }
}

//###############################//
//#       Custom Prompts        #//
//###############################//

function onEditPromptClick() {
    let popupText = `
    <div class="objective_prompt_modal">
        <div class="objective_prompt_block justifyCenter">
            <label for="mmobj-custom-prompt-select">Выбор набора промптов</label>
            <select id="mmobj-custom-prompt-select" class="text_pole"><select>
        </div>
        <div class="objective_prompt_block justifyCenter">
            <input id="mmobj-custom-prompt-new" class="menu_button" type="submit" value="Новый" />
            <input id="mmobj-custom-prompt-save" class="menu_button" type="submit" value="Сохранить" />
            <input id="mmobj-custom-prompt-delete" class="menu_button" type="submit" value="Удалить" />
        </div>
        <hr class="m-t-1 m-b-1">
        <small>Промпты, которые Objective использует в этой сессии. Можно использовать {{objective}} или {{task}} и обычные переменные шаблона. Сохраните набор, чтобы изменения остались.</small>
        <hr class="m-t-1 m-b-1">
        <div>
            <label for="mmobj-prompt-generate">Промпт генерации задач</label>
            <textarea id="mmobj-prompt-generate" type="text" class="text_pole textarea_compact" rows="6"></textarea>
            <label for="mmobj-prompt-check">Промпт проверки выполнения</label>
            <textarea id="mmobj-prompt-check" type="text" class="text_pole textarea_compact" rows="6"></textarea>
            <label for="mmobj-prompt-extension-prompt">Инъекция текущей задачи</label>
            <textarea id="mmobj-prompt-extension-prompt" type="text" class="text_pole textarea_compact" rows="6"></textarea>
        </div>
    </div>`;
    callGenericPopup(popupText, POPUP_TYPE.TEXT, "", { allowVerticalScrolling: true, wide: true });
    populateCustomPrompts(selectedCustomPrompt);

    $("#mmobj-prompt-generate").val(objectivePrompts.createTask);
    $("#mmobj-prompt-check").val(objectivePrompts.checkTaskCompleted);
    $("#mmobj-prompt-extension-prompt").val(objectivePrompts.currentTask);

    $("#mmobj-prompt-generate").on("input", () => {
        objectivePrompts.createTask = String($("#mmobj-prompt-generate").val());
        saveState();
        setCurrentTask();
    });
    $("#mmobj-prompt-check").on("input", () => {
        objectivePrompts.checkTaskCompleted = String($("#mmobj-prompt-check").val());
        saveState();
        setCurrentTask();
    });
    $("#mmobj-prompt-extension-prompt").on("input", () => {
        objectivePrompts.currentTask = String($("#mmobj-prompt-extension-prompt").val());
        saveState();
        setCurrentTask();
    });

    $("#mmobj-custom-prompt-new").on("click", () => newCustomPrompt());
    $("#mmobj-custom-prompt-save").on("click", () => saveCustomPrompt());
    $("#mmobj-custom-prompt-delete").on("click", () => deleteCustomPrompt());
    $("#mmobj-custom-prompt-select").on("change", loadCustomPrompt);
}

async function newCustomPrompt() {
    const customPromptName = await Popup.show.input("Название набора промптов", null);
    if (!customPromptName) {
        toastr.warning("Укажите название набора, чтобы сохранить.");
        return;
    }
    if (customPromptName == "default") {
        toastr.error("Нельзя перезаписать набор по умолчанию");
        return;
    }
    extension_settings.objective.customPrompts[customPromptName] = {};
    Object.assign(extension_settings.objective.customPrompts[customPromptName], objectivePrompts);
    saveSettingsDebounced();
    populateCustomPrompts(customPromptName);
}

function saveCustomPrompt() {
    const customPromptName = String($("#mmobj-custom-prompt-select").find(":selected").val());
    if (customPromptName == "default") {
        toastr.error("Нельзя перезаписать набор по умолчанию");
        return;
    }
    Object.assign(extension_settings.objective.customPrompts[customPromptName], objectivePrompts);
    saveSettingsDebounced();
    populateCustomPrompts(customPromptName);
    toastr.success("Набор сохранён: " + customPromptName);
}

async function deleteCustomPrompt() {
    const customPromptName = String($("#mmobj-custom-prompt-select").find(":selected").val());
    if (customPromptName == "default") {
        toastr.error("Нельзя удалить набор по умолчанию");
        return;
    }
    const confirmation = await Popup.show.confirm("Удалить этот набор промптов?", null);
    if (!confirmation) return;

    delete extension_settings.objective.customPrompts[customPromptName];
    saveSettingsDebounced();
    selectedCustomPrompt = "default";
    populateCustomPrompts(selectedCustomPrompt);
    loadCustomPrompt();
}

function loadCustomPrompt() {
    const optionSelected = String($("#mmobj-custom-prompt-select").find(":selected").val());
    Object.assign(objectivePrompts, extension_settings.objective.customPrompts[optionSelected]);
    selectedCustomPrompt = optionSelected;

    $("#mmobj-prompt-generate").val(objectivePrompts.createTask).trigger("input");
    $("#mmobj-prompt-check").val(objectivePrompts.checkTaskCompleted).trigger("input");
    $("#mmobj-prompt-extension-prompt").val(objectivePrompts.currentTask).trigger("input");

    saveState();
    setCurrentTask();
}

function populateCustomPrompts(selected) {
    if (!selected) selected = selectedCustomPrompt || "default";

    $("#mmobj-custom-prompt-select").empty();
    for (const customPromptName in extension_settings.objective.customPrompts) {
        const option = document.createElement("option");
        option.innerText = customPromptName;
        option.value = customPromptName;
        option.selected = customPromptName === selected;
        $("#mmobj-custom-prompt-select").append(option);
    }
}

//###############################//
//#       UI AND Settings       #//
//###############################//

const defaultSettings = {
    currentObjectiveId: null,
    taskTree: null,
    chatDepth: 2,
    checkFrequency: 3,
    hideTasks: false,
    prompts: defaultPrompts,
};

function resetState() {
    lastMessageWasSwipe = false;
    loadSettings();
}

function saveState() {
    const context = getContext();
    if (currentChatId == "") currentChatId = context.chatId;

    chat_metadata["objective"] = {
        currentObjectiveId: currentObjective.id,
        taskTree: taskTree.toSaveStateRecurse(),
        checkFrequency: $("#mmobj-check-frequency").val(),
        generateFrequency: $("#mmobj-generate-frequency").val(),
        chatDepth: $("#mmobj-chat-depth").val(),
        hideTasks: $("#mmobj-hide-tasks").prop("checked"),
        prompts: objectivePrompts,
        selectedCustomPrompt: selectedCustomPrompt,
    };

    saveMetadataDebounced();
}

// Заполнить список задач в UI.
function updateUiTaskList() {
    $("#mmobj-tasks").empty();

    if (currentObjective) {
        if (currentObjective.parentId !== "") $("#mmobj-parent").show();
        else $("#mmobj-parent").hide();
    }

    $("#mmobj-text").val(currentObjective.description);
    if (currentObjective.children.length > 0) {
        for (const task of currentObjective.children) task.addUiElement();
    } else {
        $("#mmobj-tasks").append(`
        <input id="mmobj-task-add-first" type="button" class="menu_button" value="Добавить задачу">
        `);
        $("#mmobj-task-add-first").on("click", () => {
            currentObjective.addTask("");
            setCurrentTask();
            updateUiTaskList();
        });
    }
}

function onParentClick() {
    currentObjective = getTaskById(currentObjective.parentId);
    updateUiTaskList();
    setCurrentTask();
}

async function onGenerateObjectiveClick() {
    await generateTasks();
    saveState();
}

function onChatDepthInput() {
    saveState();
    setCurrentTask();
}

function onObjectiveTextFocusOut() {
    if (currentObjective) {
        currentObjective.description = $("#mmobj-text").val();
        saveState();
    }
}

function onCheckFrequencyInput() {
    checkCounter = Number($("#mmobj-check-frequency").val());
    $("#mmobj-counter").text(checkCounter);
    saveState();
}

function onGenerateFrequencyInput() {
    generateCounter = Number($("#mmobj-generate-frequency").val());
    $("#mmobj-generate-counter").text(generateCounter);
    saveState();
}

function onHideTasksInput() {
    $("#mmobj-tasks").prop("hidden", $("#mmobj-hide-tasks").prop("checked"));
    saveState();
}

function onClearTasksClick() {
    if (currentObjective) {
        currentObjective.children = [];
        updateUiTaskList();
        setCurrentTask();
        saveState();
        toastr.success("Все задачи очищены");
    }
}

function loadTaskChildrenRecurse(savedTask) {
    let tempTaskTree = new ObjectiveTask({
        id: savedTask.id,
        description: savedTask.description,
        completed: savedTask.completed,
        parentId: savedTask.parentId,
    });
    for (const task of savedTask.children) {
        tempTaskTree.children.push(loadTaskChildrenRecurse(task));
    }
    return tempTaskTree;
}

function loadSettings() {
    currentChatId = getContext().chatId;

    taskTree = null;
    currentObjective = null;

    if (!extension_settings.objective) extension_settings.objective = {};
    if (Object.keys(extension_settings.objective).length === 0) {
        Object.assign(extension_settings.objective, { "customPrompts": { "default": defaultPrompts } });
    }
    if (!extension_settings.objective.customPrompts) {
        extension_settings.objective.customPrompts = { "default": defaultPrompts };
    }

    if (currentChatId == undefined) currentChatId = "no-chat-id";

    if (currentChatId in extension_settings.objective) {
        chat_metadata["objective"] = extension_settings.objective[currentChatId];
        delete extension_settings.objective[currentChatId];
    }

    if (!("objective" in chat_metadata)) {
        Object.assign(chat_metadata, { objective: defaultSettings });
    }

    // Миграция старого «плоского» objective → дерево.
    if ("objective" in chat_metadata.objective) {
        taskTree = new ObjectiveTask({ id: 0, description: chat_metadata.objective.objective });
        currentObjective = taskTree;

        if ("tasks" in chat_metadata.objective) {
            let idIncrement = 0;
            taskTree.children = chat_metadata.objective.tasks.map((task) => {
                idIncrement += 1;
                return new ObjectiveTask({
                    id: idIncrement,
                    description: task.description,
                    completed: task.completed,
                    parentId: taskTree.id,
                });
            });
        }
        saveState();
        delete chat_metadata.objective.objective;
        delete chat_metadata.objective.tasks;
    } else {
        if (chat_metadata.objective.taskTree) {
            taskTree = loadTaskChildrenRecurse(chat_metadata.objective.taskTree);
        }
    }

    if (!taskTree) {
        taskTree = new ObjectiveTask({ id: 0, description: $("#mmobj-text").val() });
    }

    currentObjective = taskTree;
    checkCounter = chat_metadata["objective"].checkFrequency;
    generateCounter = Number(chat_metadata["objective"].generateFrequency) || 0;
    objectivePrompts = chat_metadata["objective"].prompts || defaultPrompts;
    selectedCustomPrompt = chat_metadata["objective"].selectedCustomPrompt || "default";

    $("#mmobj-counter").text(checkCounter);
    $("#mmobj-generate-counter").text(generateCounter);
    $("#mmobj-text").text(taskTree.description);
    updateUiTaskList();
    $("#mmobj-chat-depth").val(chat_metadata["objective"].chatDepth);
    $("#mmobj-check-frequency").val(chat_metadata["objective"].checkFrequency);
    $("#mmobj-generate-frequency").val(chat_metadata["objective"].generateFrequency || 0);
    $("#mmobj-hide-tasks").prop("checked", chat_metadata["objective"].hideTasks);
    $("#mmobj-tasks").prop("hidden", $("#mmobj-hide-tasks").prop("checked"));
    setCurrentTask(null, true);
}

//###############################//
//#     Кнопка, панель, стили   #//
//###############################//

function injectStyles() {
    if (document.getElementById("mm-objective-style")) return;
    const s = document.createElement("style");
    s.id = "mm-objective-style";
    s.textContent = `
        #${BTN_ID} { opacity: .6; transition: opacity .15s, color .15s; }
        #${BTN_ID}:hover { opacity: 1; }

        #${PANEL_ID} { position: fixed; inset: 0; z-index: 10050; display: none;
            align-items: center; justify-content: center; padding: 12px;
            box-sizing: border-box; background: rgba(0,0,0,.5); }
        #${PANEL_ID}.mmobj-open { display: flex; }
        #${PANEL_ID} .mmobj-box { width: min(680px, 96vw); max-height: 88vh; display: flex;
            flex-direction: column; padding: 14px; border-radius: 12px;
            background: var(--SmartThemeBlurTintColor, #1e1e2a);
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); }
        #${PANEL_ID} .mmobj-head { display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 10px; }
        #${PANEL_ID} .mmobj-title { font-weight: 600; }
        #${PANEL_ID} .mmobj-x { cursor: pointer; opacity: .7; }
        #${PANEL_ID} .mmobj-x:hover { opacity: 1; }
        #${PANEL_ID} .mmobj-body { overflow-y: auto; padding-right: 4px; }

        #${PANEL_ID} .mmobj-help { margin-bottom: 10px; border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15));
            border-radius: 8px; padding: 4px 10px; background: var(--black30a, rgba(0,0,0,.2)); }
        #${PANEL_ID} .mmobj-help > summary { cursor: pointer; user-select: none; opacity: .85; }
        #${PANEL_ID} .mmobj-help ul { margin: 6px 0 4px; padding-left: 18px; }
        #${PANEL_ID} .mmobj-help li { margin: 3px 0; }

        #mmobj-counter, #mmobj-generate-counter { font-weight: 600; color: orange; }

        .objective_block { display: flex; align-items: center; column-gap: 5px; flex-wrap: wrap; }
        .objective_prompt_block { display: flex; align-items: baseline; column-gap: 5px; flex-wrap: wrap; }
        .objective_block_control { align-items: baseline; }
        .objective_block_control small, .objective_block_control label { width: max-content; }
        .objective-task-button { margin: 0; outline: none; border: none; cursor: pointer;
            transition: .3s; opacity: .7; align-items: center; justify-content: center; }
        .objective-task-button:hover { opacity: 1; }
        [id^=mmobj-task-delete-] { color: #da3f3f; }
        #mmobj-tasks span { margin: unset; margin-bottom: 5px !important; }
        .objective_prompt_modal textarea { max-height: 50vh; max-height: 50dvh; resize: vertical; }
    `;
    document.head.appendChild(s);
}

function panelHtml() {
    return `
    <div class="mmobj-box">
        <div class="mmobj-head">
            <div class="mmobj-title">🎯 Цели (Objective)</div>
            <div class="mmobj-x fa-solid fa-xmark interactable" title="Закрыть" tabindex="0"></div>
        </div>
        <div class="mmobj-body">
            <details class="mmobj-help">
                <summary>Как пользоваться</summary>
                <div>
                    Впиши цель — ИИ разобьёт её на список задач и будет незаметно вести к ним по ходу ролеплея,
                    периодически проверяя, что уже выполнено.
                    <ul>
                        <li><b>Авто-создать задачи</b> — ИИ сам придумает список шагов для цели.</li>
                        <li><b>Позиция в чате</b> — на какой глубине подмешивать текущую задачу в контекст (0 — у самого конца).</li>
                        <li><b>Частота проверки</b> — раз в N ответов ИИ проверяет, выполнена ли задача (0 = выключено).</li>
                        <li><b>Частота авто-создания</b> — раз в N ответов пересоздавать список задач (0 = выключено).</li>
                        <li>Галочка — отметить задачу выполненной; 🍴 — разбить на подзадачи; ✚ — добавить; ✕ — удалить.</li>
                        <li><b>Проверить сейчас</b> / <b>Отметить текущую</b> — ручная проверка и завершение текущей задачи.</li>
                    </ul>
                </div>
            </details>

            <label for="mmobj-text"><small>Впиши цель. ИИ будет стараться выполнять задачи автономно.</small></label>
            <textarea id="mmobj-text" type="text" class="text_pole textarea_compact" rows="4"></textarea>
            <div class="objective_block flex-container">
                <input id="mmobj-generate" class="menu_button" type="submit" value="Авто-создать задачи" />
                <input id="mmobj-clear" class="menu_button" type="submit" value="Очистить" />
                <label class="checkbox_label"><input id="mmobj-hide-tasks" type="checkbox"> Скрыть задачи</label>
            </div>
            <div id="mmobj-parent" class="objective_block flex-container">
                <i class="objective-task-button fa-solid fa-circle-left fa-2x" title="К родительской"></i>
                <small>К родительской задаче</small>
            </div>

            <div id="mmobj-tasks"> </div>
            <div class="objective_block margin-bot-10px">
                <div class="objective_block objective_block_control flex1 flexFlowColumn">
                    <label for="mmobj-chat-depth">Позиция в чате</label>
                    <input id="mmobj-chat-depth" class="text_pole widthUnset" type="number" min="0" max="99" />
                </div>
                <br>
                <div class="objective_block objective_block_control flex1">
                    <label for="mmobj-check-frequency">Частота проверки</label>
                    <input id="mmobj-check-frequency" class="text_pole widthUnset" type="number" min="0" max="99" />
                    <small>(0 = выкл)</small>
                </div>
                <br>
                <div class="objective_block objective_block_control flex1">
                    <label for="mmobj-generate-frequency">Частота авто-создания</label>
                    <input id="mmobj-generate-frequency" class="text_pole widthUnset" type="number" min="0" max="99" />
                    <small>(0 = выкл)</small>
                </div>
            </div>
            <span> Сообщений до проверки выполнения: <span id="mmobj-counter">0</span></span>
            <br>
            <span> Сообщений до перегенерации задач: <span id="mmobj-generate-counter">0</span></span>
            <div class="objective_block flex-container" style="margin-top:8px;">
                <input id="mmobj_prompt_edit" class="menu_button" type="submit" value="Промпты" />
                <input id="mmobj-manual-check" class="menu_button" type="button" value="Проверить сейчас" title="Запросить у ИИ проверку выполнения текущей задачи" />
                <input id="mmobj-complete-current" class="menu_button" type="button" value="Отметить текущую" title="Отметить текущую задачу выполненной" />
            </div>
        </div>
    </div>`;
}

function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = panelHtml();
    document.body.appendChild(panel);

    // Клик по фону (вне окна) — закрыть.
    panel.addEventListener("click", (e) => { if (e.target === panel) closePanel(); });
    $("#mmobj-parent").hide();
}

function openPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.add("mmobj-open");
}

function closePanel() {
    document.getElementById(PANEL_ID)?.classList.remove("mmobj-open");
}

function createButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("div");
    btn.id = BTN_ID;
    btn.className = "fa-solid fa-bullseye interactable";
    btn.title = "Цели (Objective) — задачи для ИИ по ходу ролеплея";
    btn.tabIndex = 0;
    btn.addEventListener("click", openPanel);

    const brain = document.getElementById("mm-souldiary-button");
    const statbar = document.getElementById("mm-statbar-button");
    const toc = document.getElementById("mm-toc-button");
    const wrench = document.getElementById("mm-wand-button");
    const wand = document.getElementById("extensionsMenuButton");
    if (brain) brain.after(btn);
    else if (statbar) statbar.after(btn);
    else if (toc) toc.after(btn);
    else if (wrench) wrench.after(btn);
    else document.getElementById("leftSendForm")?.appendChild(btn);

    const wandOrder = wand ? (parseInt(getComputedStyle(wand).order, 10) || 4) : 4;
    btn.style.order = String(wandOrder + 5);
}

function wireEvents() {
    $(document).on("click", `#${BTN_ID}`, openPanel);
    $(document).on("click", `#${PANEL_ID} .mmobj-x`, closePanel);
    $(document).on("click", "#mmobj-generate", onGenerateObjectiveClick);
    $(document).on("input", "#mmobj-chat-depth", onChatDepthInput);
    $(document).on("input", "#mmobj-check-frequency", onCheckFrequencyInput);
    $(document).on("input", "#mmobj-generate-frequency", onGenerateFrequencyInput);
    $(document).on("click", "#mmobj-hide-tasks", onHideTasksInput);
    $(document).on("click", "#mmobj-clear", onClearTasksClick);
    $(document).on("click", "#mmobj_prompt_edit", onEditPromptClick);
    $(document).on("click", "#mmobj-parent", onParentClick);
    $(document).on("focusout", "#mmobj-text", onObjectiveTextFocusOut);
    $(document).on("click", "#mmobj-manual-check", checkTaskCompleted);
    $(document).on("click", "#mmobj-complete-current", markTaskCompleted);
}

function onMessageReceived() {
    if (currentChatId == undefined || jQuery.isEmptyObject(currentTask) || lastMessageWasSwipe) {
        lastMessageWasSwipe = false;
        return;
    }
    let checkForCompletion = false;
    const noCheckTypes = ["continue", "quiet", "impersonate"];
    const lastType = substituteParams("{{lastGenerationType}}");
    if (Number($("#mmobj-check-frequency").val()) > 0 && !noCheckTypes.includes(lastType)) {
        if (--checkCounter <= 0) {
            checkForCompletion = true;
            checkCounter = Number($("#mmobj-check-frequency").val());
        }
    }

    let generateNewTasks = false;
    if (Number($("#mmobj-generate-frequency").val()) > 0 && !noCheckTypes.includes(lastType)) {
        if (--generateCounter <= 0) {
            generateNewTasks = true;
            generateCounter = Number($("#mmobj-generate-frequency").val());
        }
    }

    const checkTaskPromise = checkForCompletion ? checkTaskCompleted() : Promise.resolve();
    const generatePromise = generateNewTasks ? generateTasks() : Promise.resolve();

    Promise.all([checkTaskPromise, generatePromise]).finally(() => {
        setCurrentTask();
        $("#mmobj-counter").text(checkCounter);
        $("#mmobj-generate-counter").text(generateCounter);
    });
}

/** Точка входа — вызывается из machineMechanic.js. */
export function initObjective(ctx) {
    injectStyles();
    buildPanel();
    createButton();
    wireEvents();
    loadSettings();

    const es = ctx?.eventSource || eventSource;
    const et = ctx?.eventTypes || event_types;

    es.on(et.CHAT_CHANGED, () => { resetState(); createButton(); });
    es.on(et.MESSAGE_SWIPED, () => { lastMessageWasSwipe = true; });
    es.on(et.MESSAGE_RECEIVED, onMessageReceived);

    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: "taskcheck",
            callback: checkTaskCompleted,
            helpString: "Проверяет, выполнена ли текущая задача",
            returns: "true или false",
        }));
    } catch (e) {
        // команда уже зарегистрирована (например, standalone-версией Objective) — не критично
    }
}
