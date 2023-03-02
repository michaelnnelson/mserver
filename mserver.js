import assert from 'assert'
import fs from 'fs'
import { WebSocketServer } from 'ws'

import { Card, cardsToStr, sortSequence, GameInfo, createDeck, shuffleDeck, drawCard,
         PlayerInfo, validateGameInfo, validatePlayerInfo,
        GAME_STATE_ACTIVE, GAME_STATE_PAUSED, 
        GAME_STATE_IDLE, GAME_STATE_CONNECTING } from '../machiavelli/src/mutils.mjs'

const GAME_DATA_DIR = "./game_data/";
const CONFIG_SUFFIX = ".config";
const STATE_SUFFIX = ".state";

var port = 8080;
var wss = new WebSocketServer({ port: port });

console.log('listening on port: ' + port);

var connectedClients = [];
var gameMap = new Map();

function sendError(ws, incomingMsg, msgString, playerName = "") {
  var msg = {
    type: "Status",
    requestId: incomingMsg.requestId,
    status: "Error",
    msg: msgString,
    playerName: playerName
  };
  ws.send(JSON.stringify(msg));
  return false;
}

function sendSuccess(ws, incomingMsg, playerName = "") {
  var msg = {
    type: "Status",
    requestId: incomingMsg.requestId,
    status: "Ok",
    msg: "Success",
    playerName: playerName
  };
  ws.send(JSON.stringify(msg));
  return true;
}

var nextPlayerId = 1000; 

class Player {
  constructor(name, isBot) {
    this.name = name;
    this.isBot = isBot;
    this.hand = [];
    this.webSocket = null;
  }

  send(msg) {
    if (this.webSocket) {
      console.log("Sending msg", msg);

      if (!msg.playerName) {
        msg.playerName = this.name;
      }
      this.webSocket.send(JSON.stringify(msg), err => {
        if (err) {
          console.log("Error sending message", err);
        } else {
          console.log("Message sent OK");
        }
      });
    }
  }

  sendSuccessStatus(incomingMsg) {
    sendSuccess(this.webSocket, incomingMsg);
  }

  sendErrorStatus(incomingMsg, errorMsg) {
    sendError(this.webSocket, incomingMsg, errorMsg, this.name);
  }
}

class Game {
  constructor(gameName, playerOrder, playerMap, cardsPerHand) {
    this.gameName = gameName;
    this.playerOrder = playerOrder;
    this.playerMap = playerMap;
    this.cardsPerHand = cardsPerHand;
    this.resetGameState();
  }

  resetGameState() {
    this.board = [];
    this.buckets = [[]];
    this.deck = shuffleDeck(createDeck(2, 4, 13, 4));
    this.stateVersion = new Date().getTime();
    this.handNumber = this.stateVersion ;
    this.nextPlayerIndex = 0;
    this.active = false;
    this.paused = false;
    for (let player of this.playerMap.values()) {
      if (player.webSocket) {
        player.webSocket = null;
        player.hand = [];
      }
    }
  }
  
  dealCards(cardsPerHand, numHands) {
    var hands = [];
    for (var i = 0; i < numHands; i++) {
      hands.push([]);
    }
    for (i = 0; i < numHands; i++) {
      for (var j = 0; j < cardsPerHand; j++) {
        drawCard(hands[i], this.deck);
      }
    }
  
    return hands;
  }

  configFilePath() {
    return GAME_DATA_DIR + this.gameName + CONFIG_SUFFIX;
  }

  tmpConfigFilePath() {
    return GAME_DATA_DIR + "_" + this.gameName + CONFIG_SUFFIX;
  }

  stateFilePath() {
    return GAME_DATA_DIR + this.gameName + STATE_SUFFIX;
  }

  tmpStateFilePath() {
    return GAME_DATA_DIR + "_" + this.gameName + STATE_SUFFIX;
  }
  
  createGameStateMsg() {
    var playerInfo = [];
    for (let player of this.playerMap.values()) {
      console.log("createGameStateMsg player: name", player.name);      
      console.log("createGameStateMsg player: hand", cardsToStr(player.hand));

      assert(player.hand);
      playerInfo.push({ name: player.name, hand: player.hand, isBot: player.isBot });
    }

    return({
        type: "UpdateGameState", 
        version: this.stateVersion,
        handNumber: this.handNumber,
        board: this.board, 
        buckets: this.buckets, 
        playerInfo: playerInfo
    });
  }

  broadcastGameState(skipSocket) {
    var gameStateMsg = this.createGameStateMsg();

    for (let player of this.playerMap.values()) {
      if (player.webSocket !== skipSocket) {
        player.send(gameStateMsg);
      }
    }
  }

  sendGameState(player) {
    var gameStateMsg = this.createGameStateMsg();
    player.send(gameStateMsg);
  }

  receiveStateUpdate(ws, msg) {
    if (!this.active) {
      return sendError(ws, msg, "Board update on inactive game");
    }
    
    sendSuccess(ws, msg);
    
    if (msg.handNumber === this.handNumber && msg.playerName === this.currentPlayer.name) {
      this.updateGameState(msg.board, msg.buckets, msg.hand);
      this.broadcastGameState(ws);
    } else {
      console.log("receiveStateUpdate: got (" + msg.handNumber, ", " + msg.playerName + 
                  ") want (" + this.handNumber + ", " + this.currentPlayer.name + ")");
    }
  }

  joinGame(ws, msg) {
    let player = this.playerMap.get(msg.playerName);
    console.log("player", player);
    if (!player) {
      return sendError(ws, msg, msg.playerName + " is not in the game");
    } else if (player.webSocket) {
      return sendError(ws, msg, msg.playerName + " has already joined the game");
    } else if (player.isBot) {
      return sendError(ws, msg, msg.playerName + " is a bot");
    }
    player.webSocket = ws;
    player.sendSuccessStatus(msg);
    if (this.active) {
      this.sendGameState(player);
    }
    for (let player of this.playerMap.values()) {
      if (!player.webSocket && !player.isBot) {
        return true;
      }
    }
    this.play();
    return true;
  }

  canDeleteGame(ws, msg) {
    if (this.active) {
      return msg.gameName + "is active";
    } else {
      var joinedPlayers = [];
      for (let player of this.playerMap.values()) {
        if (player.webSocket) {
          joinedPlayers.push(player);
        }
      }
      if (joinedPlayers.length > 0) {
        var msg = joinedPlayers[0].name;
        if (joinedPlayers.length === 2) {
          msg += " and " + joinedPlayers[1].name;
        } else {
          for (var i = 1; i < joinedPlayers.length; i++) {
            var player = joinedPlayers[i];
            msg += ',';
            if (i === joinedPlayers.length - 1 && joinedPlayers.length > 2) {
              msg += " and "
            }
            msg += player.name;
          }
          msg += " have already joined the game";
        }
        return msg;
      } else {
        return null;
      }
    }
  }

  leaveGame(ws, msg) {
    let player = this.playerMap.get(msg.playerName);
    if (!player) {
      return sendError(ws, msg, msg.playerName + " is not in the game");
    } else if (!player.webSocket) {
      return sendError(ws, msg, msg.playerName + " has not joined the game");
    } else if (player.isBot) {
      return sendError(ws, msg, msg.playerName + " is a bot");
    }
    player.sendSuccessStatus(msg);    
    player.webSocket = null;
    if (this.active) {
      this.paused = true;
    }
    broadcastGameConfigs();
    return true;
  }

  abortGame(ws, msg) {
    console.log("Aborting game", msg.gameName);
    this.resetGameState();
    broadcastGameConfigs();
    fs.rm(this.stateFilePath(), () => {});
    sendSuccess(ws, msg);
  }
  
  updateGameState(board, buckets, hand) {
    if (board) {
      this.board = board;
    }
    if (buckets) {
      this.buckets = buckets;
    }
    if (hand) {
      this.currentPlayer.hand = hand;
    }
    this.stateVersion = new Date().getTime();
  }
  
  validateNewConfig(ws, msg, newPlayerMap) {
    if (this.active) {
      sendError(ws, msg, msg.gameName + " is being played");
      return;
    }
    for (let [name, player] of this.playerMap){
      if (player.webSocket) {
        var newPlayer = newPlayerMap.get(name);
        if (!newPlayer) {
          sendError(ws, msg, 
                    msg.playerName + " has already joined but is missing from game config");
          return false;
        }
        newPlayer.webSocket = player.webSocket;
      }
    }
    return true;
  }

  appendConfig(configs) {
    var playerConnected = false;
    var players = [];
    for (let player of this.playerMap.values()) {
      if (player.webSocket) {
        playerConnected = true;
      }
      players.push(new PlayerInfo(player.name, player.isBot, player.webSocket !== null));
    }
    var gameState;
    if (this.paused) {
      gameState = GAME_STATE_PAUSED;
    } else if (this.active) {
      gameState = GAME_STATE_ACTIVE;
    } else if (playerConnected) {
      gameState = GAME_STATE_CONNECTING;
    } else {
      gameState = GAME_STATE_IDLE;
    }
    configs.push(new GameInfo(this.gameName, this.cardsPerHand, players, gameState));
  }

  setGameState(gameState) {
    if (this.playerMap.size !== gameState.players.length) {
      console.log("There are", this.playerMap.size, "configs but", gameState.players.length, "players in the saved state");
      return;
    }
    this.active = true;
    this.paused = true;
    this.stateVersion = gameState.stateVersion;
    this.handNumber = gameState.handNumber;
    this.nextPlayerIndex = gameState.nextPlayerIndex;
    this.board = gameState.board;
    this.deck = gameState.deck;
    this.currentPlayer = this.playerMap.get(this.playerOrder[this.nextPlayerIndex]);

    gameState.players.forEach(gameStatePlayer => {
      let player = this.playerMap.get(gameStatePlayer.name);
      if (!player) {
        console.log("Player", gameStatePlayer.name, "is missing from the config");
        return;
      }     
      assert(player.isBot === gameStatePlayer.isBot);
      player.hand = gameStatePlayer.hand;
    });
  }

  persistGameState(handDoneWebSocket, handDoneMsg) {
    var players = [];
    for (let player of this.playerMap.values()) {
      players.push({
        name: player.name,
        isBot: player.isBot,
        hand: player.hand
      });
    }
    let persistedState = {
      gameName: this.gameName,
      stateVersion: this.stateVersion,
      handNumber: this.handNumber,
      nextPlayerIndex: this.nextPlayerIndex,
      board: this.board,
      players: players,
      deck: this.deck
    };

    fs.writeFile(this.tmpStateFilePath(), JSON.stringify(persistedState), err => {
      if (err) {
        console.error("writeFile of " + this.tmpStateFilePath() + " failed with", err);
        this.finishHandDone(handDoneWebSocket, handDoneMsg, "Failed to save state");
      } else {
        fs.rename(this.tmpStateFilePath(), this.stateFilePath(), err => {
          if (err) {
            console.log("rename of " + this.tmpStateFilePath() + " to " + this.stateFilePath() + " failed with", err);
            this.finishHandDone(handDoneWebSocket, handDoneMsg, "Failed to save state");
          } else {
            this.finishHandDone(handDoneWebSocket, handDoneMsg);
          }
        });
      }
    });
  }

  handDone(ws, msg) {
    if (msg.playerName !== this.currentPlayer.name) {
      return sendError(ws, msg, 
                       "Invalid player name:" + msg.playerName + "!==" + this.currentPlayer.name);
    } else if (msg.handNumber !== this.handNumber) {
      return sendError(ws, msg, 
                       "Invalid hand number:" + msg.handNumber + "!==" + this.handNumber);
    }
    if (msg.drawCard) {
      drawCard(this.currentPlayer.hand, this.deck);
    } else {
      this.currentPlayer.hand = msg.hand;
    }
    this.updateGameState(msg.board, [[]]);

    if (this.currentPlayer.hand.length === 0) {
      this.broadcastGameState();
      this.resetGameState();
      broadcastGameConfigs();
      fs.rm(this.stateFilePath(), () => {});
    } else {
      this.nextPlayerIndex++;
      if (this.nextPlayerIndex === this.playerOrder.length) {
        this.nextPlayerIndex = 0;
      }
      this.handNumber++;
      this.persistGameState(ws, msg);
    }
  }

  finishHandDone(ws, msg, err) {
    console.log("finishHandDone", err);
    if (err) {
      sendError(ws, msg, err);
    } else {
      sendSuccess(ws, msg);
      this.broadcastGameState();
      this.playHand();
    }
  }

  playHand() {        
    this.currentPlayer = this.playerMap.get(this.playerOrder[this.nextPlayerIndex]);;
    this.sendPlayHandMsg();
  }

  sendPlayHandMsg() {
    var msg = {
      type: "PlayHand", 
      playerName: this.currentPlayer.name,
      isBot: this.currentPlayer.isBot,
      hand: this.currentPlayer.hand,
      handNumber: this.handNumber
    };
    console.log("sendPlayHandMsg", this.currentPlayer.name);
    if (this.currentPlayer.isBot) {
      console.log("Sending to dealer", this.dealer.name);
      this.dealer.send(msg);
    } else {
      console.log("Sending to", this.currentPlayer.name);
      this.currentPlayer.send(msg);
    }
  }

  play() {
    assert(!this.active || this.paused);
    if (this.paused) {
      delete this.paused;
      assert(this.currentPlayer);
      for (let player of this.playerMap.values()) {
        if (player.webSocket) {
          this.dealer = player;
          break;
        }
      }
      this.broadcastGameState();
      this.sendPlayHandMsg();
    } else {
      this.active = true;
      this.playerOrder.some((playerName, index) => {
        let player = this.playerMap.get(playerName);
        assert(player);
        if (player.webSocket) {
          this.dealer = player;
          this.nextPlayerIndex = index;
          return true;
        } else {
          return false;
        }
      });    
      assert(this.dealer);
      console.log("Num players", this.playerOrder.length);
      var hands = this.dealCards(this.cardsPerHand, this.playerOrder.length);
      console.log("hands",)
      this.playerOrder.forEach((playerName, index) => {
        var player = this.playerMap.get(playerName);
        assert(player);
        player.hand = hands[index];
        console.log("player.hand", player.hand);
      });    
      this.broadcastGameState();
      this.playHand();
    }
  }

  processSocketClose(ws) {
    for (let player of this.playerMap.values()) {
      if (player.webSocket === ws) {
        console.log("player", player.name, "disconnected");
        player.webSocket = null;
        broadcastGameConfigs();
        if (this.active) {
          this.paused = true;
        }
      }
    }
  }
}

function lookupGame(ws, msg) {
  let game = gameMap.get(msg.gameName);
  if (!game) {
    sendError(ws, msg, msg.type + ": " + msg.gameName + " doesn't exist");
  }
  return game;
}

function processHandDoneMsg(ws, msg) {
  let game = lookupGame(ws, msg);
  if (game) {
    game.handDone(ws, msg);
  }
}

function processStateUpdateMsg(ws, msg) {
  let game = lookupGame(ws, msg);
  if (game) {
    game.receiveStateUpdate(ws, msg);
  }
}

function processJoinGameMsg(ws, msg) {
  let game = lookupGame(ws, msg);
  if (game) {
    if (game.joinGame(ws, msg)) {
      console.log("Joined game");
      broadcastGameConfigs();
    }
  }
}

function processLeaveGameMsg(ws, msg) {
  let game = lookupGame(ws, msg);
  if (game) {
    game.leaveGame(ws, msg);
  }
}

function processAbortGameMsg(ws, msg) {
  let game = lookupGame(ws, msg);
  if (game) {
    game.abortGame(ws, msg);
  }
}

function processDeleteGameMsg(ws, msg) {
  let game = lookupGame(ws, msg);
  if (game) {
    var errMsg = game.canDeleteGame();
    if (errMsg) {
      return sendError(ws, msg, errMsg);
    } else {
      gameMap.delete(msg.gameName);
      fs.rm(this.configFilePath(), err => {
        if (err) {
          console.log("Failed to remove file", this.configFilePath(), err);
        }
      })
      broadcastGameConfigs();
    }
  }
}

function processConfigGameMsg(ws, msg) {
  var newPlayerMap = new Map();
  var newPlayerOrder = [];
  var foundOneNonBot = false;
  
  if (!msg.config) {
    return sendError(ws, msg, "Missing config property");
  } else if (msg.config.players.length < 2) {
    return sendError(ws, msg, "Must have at least 2 players");
  }
  
  var errMsg = validateGameInfo(msg.config);
  if (errMsg) {
    return sendError(ws, msg, "Error in GameInfo: " + errMsg);
  }

  for (var i = 0; i < msg.config.players.length; i++) {
    var player = msg.config.players[i];
    console.log("player", player);
    errMsg = validatePlayerInfo(player);
    if (errMsg) {
      return sendError(ws, msg, "Error in PlayerInfo: " + errMsg);
    } else if (player.name.length === 0) {
      return sendError(ws, msg, "Empty player name in config msg");
    } else if (newPlayerMap.has(player.name)) {
      return sendError(ws, msg, player.name + "is used more than once");
    } else {
      newPlayerMap.set(player.name, new Player(player.name, player.isBot));
      if (!player.isBot) {
        foundOneNonBot = true;
      }
      newPlayerOrder.push(player.name);
    }
  }
  if (!foundOneNonBot) {
    sendError(ws, msg, "Need at least one real person in game");
    return;
  }

  var game = gameMap.get(msg.config.gameName);
  if (game) {
    if (!game.validateNewConfig(ws, msg, newPlayerMap)) {
      return;
    }
  }
  
  gameMap.set(msg.config.gameName, new Game(msg.config.gameName, newPlayerOrder, newPlayerMap, msg.config.cardsPerHand));
  fs.writeFile(this.tmpConfigFilePath(), JSON.stringify(msg.config), err => {
    if (err) {
      console.error("writeFile of " + this.tmpConfigFilePath() + " failed with", err);
    } else {
      fs.rename(this.tmpConfigFilePath(), this.configFilePath(), err => {
        if (err) {
          console.log("rename of " + this.tmpConfigFilePath() + " to " + this.configFilePath() + " failed with", err);
        }
      });
    }
  });

  sendSuccess(ws, msg);
  broadcastGameConfigs();
}

function sendGameConfigMsg(ws, configs) {
  ws.send(JSON.stringify({ 
    type: "GameConfigs", 
    configs: configs
  }));
}

function sendGameConfigs(ws) {
  var configs = [];
  for (let game of gameMap.values()) {
    game.appendConfig(configs);
  }
  sendGameConfigMsg(ws, configs);
}

function broadcastGameConfigs() {
  var configs = [];
  for (let game of gameMap.values()) {
    game.appendConfig(configs);
  }
  connectedClients.forEach(ws => {
    sendGameConfigMsg(ws, configs);
  });
}

fs.readdir(GAME_DATA_DIR, function(err, filenames) {
  if (err) {
    console.log("Error opening", GAME_DATA_DIR, err);
    return;
  }
  
  var configsToRead = [];
  var statesToRead = [];
  filenames.forEach(fileName => {
    if (fileName[0] == '_') {
      fs.rm(GAME_DATA_DIR + fileName, () => {});
    } else if (fileName.endsWith(CONFIG_SUFFIX)) {
      configsToRead.push(fileName);
    } else if (fileName.endsWith(STATE_SUFFIX)) {
      statesToRead.push(fileName)
    }
  });

  var configsLeftToRead = configsToRead.length;

  configsToRead.forEach(fileName => {
    var path = GAME_DATA_DIR + fileName;
    fs.readFile(path, 'utf-8', function(err, content) {
      if (err) {
        console.log("Error reading file", path)
        return;
      }
      var gameConfig = JSON.parse(content);
      console.log("Read gameConfig", gameConfig);
      assert(gameConfig.gameName);
      assert(!gameMap.has(gameConfig.gameName));
      var playerOrder = [];
      var playerMap = new Map();
      gameConfig.players.forEach((player) => {
        playerOrder.push(player.name);
        playerMap.set(player.name, new Player(player.name, player.isBot)); 
      });
      gameMap.set(gameConfig.gameName, new Game(gameConfig.gameName, playerOrder, playerMap, gameConfig.cardsPerHand));
      configsLeftToRead--;
      if (configsLeftToRead === 0) {
        readStateFiles();
      }
    });
  });

  function readStateFiles() {
    statesToRead.forEach((fileName) => {
      var path = GAME_DATA_DIR + fileName;
      fs.readFile(path, 'utf-8', function(err, content) {
        if (err) {
          console.log("Error reading file", path)
          return;
        }
        
        var gameState = JSON.parse(content);
        console.log("Read gameState", gameState);
        assert(gameState.gameName);
        let game = gameMap.get(gameState.gameName);
        if (!game) {
          console.log("No game config for ", gameState.gameName);
          return;
        }
        game.setGameState(gameState);
      });
    });
  }
});

wss.on('connection', function connection(ws) {
  ws.on('message', function(message) {
    var msgObj = JSON.parse(message);
    console.log("msgObj", msgObj);
    switch (msgObj.type) {
      case "HandDone":
        processHandDoneMsg(ws, msgObj);
        break;
      case "StateUpdate":
        processStateUpdateMsg(ws, msgObj);
        break;
      case "JoinGame":
        processJoinGameMsg(ws, msgObj);
        break;
      case "LeaveGame":
        processLeaveGameMsg(ws, msgObj);
        break;
      case "ConfigGame":
        processConfigGameMsg(ws, msgObj);
        break;
      case "DeleteGame":
        processDeleteGameMsg(ws, msgObj);
        break;
      case "AbortGame":
        processAbortGameMsg(ws, msgObj);
        break;
      default:
        ws.send('echo: ' + message);
        break;
    }
  });
  ws.on('close', () => {
    console.log("Closing socket");
    for (let game of gameMap.values()) {
      game.processSocketClose(ws);
    }
    for (var i = 0; i < connectedClients.length; i++) {
      if (connectedClients[i] === ws) {
        connectedClients.splice(i, 1);
        break;
      }
    }
  });

  console.log('new client connected!');
  connectedClients.push(ws);
  sendGameConfigs(ws);
});
