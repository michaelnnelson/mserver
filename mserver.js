import assert from 'assert'
import fs from 'fs'
import { WebSocketServer } from 'ws'

import { Card, cardsToStr, sortSequence, GameInfo, 
         PlayerInfo, validateGameInfo, validatePlayerInfo } from '../machiavelli/src/mutils.mjs'

const GAME_CONFIG_DIR = "./game_config/";
var port = 8080;
var wss = new WebSocketServer({ port: port });

console.log('listening on port: ' + port);

var connectedClients = [];
var gameMap = new Map();

var cardId = 100;

function createDeck(numDecks, numJokers, numValues, numSuits) {
  var deck = [];

  for (var i = 0; i < numDecks; i++) {
    for (var value = 1; value <= numValues; value++) {
      for (var suit = 0; suit < numSuits; suit++) {
        deck.push(new Card(value, suit));
      }
    }
  }

  for (i = 0; i < numJokers; i++) {
    var card = new Card(0, 0, true);
    deck.push(card);
  }
  return deck;
}

function shuffleDeck(deck) {
  var shuffledDeck = [];
  while (deck.length > 0) {
    let index = Math.floor(Math.random() * deck.length);
    let card = deck.splice(index, 1);
    shuffledDeck.push(card[0]);
  }
  return shuffledDeck;
}

function sendError(ws, incomingMsg, msgString, playerId = -1) {
  var msg = {
    type: "Status",
    requestId: incomingMsg.requestId,
    status: "Error",
    msg: msgString,
    playerId: playerId
  };
  ws.send(JSON.stringify(msg));
  return false;
}

function sendSuccess(ws, incomingMsg, playerId = -1) {
  var msg = {
    type: "Status",
    requestId: incomingMsg.requestId,
    status: "Ok",
    msg: "Success",
    playerId: playerId
  };
  ws.send(JSON.stringify(msg));
  return true;
}

var nextPlayerId = 1000; 

class Player {
  constructor(name, isBot) {
    this.name = name;
    this.isBot = isBot;
    this.id = nextPlayerId++;
    this.hand = [];
    this.webSocket = null;
  }

  send(msg) {
    if (this.webSocket) {
      console.log("Sending msg", msg);

      if (!msg.playerId) {
        msg.playerId = this.id;
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
    sendError(this.webSocket, incomingMsg, errorMsg, this.id);
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

  drawCard(hand) {
    console.log("Deck length", this.deck.length);
    var card = this.deck.splice(0, 1)[0];
    assert(card);
    hand.push(card);
    sortSequence(hand);
    return card;
  }
  
  dealCards(cardsPerHand, numHands) {
    var hands = [];
    for (var i = 0; i < numHands; i++) {
      hands.push([]);
    }
    for (i = 0; i < numHands; i++) {
      for (var j = 0; j < cardsPerHand; j++) {
        this.drawCard(hands[i]);
      }
    }
  
    return hands;
  }
  
  createGameStateMsg() {
    var playerInfo = [];
    for (let player of this.playerMap.values()) {
      console.log("createGameStateMsg player: name", player.name);      
      console.log("createGameStateMsg player: hand", cardsToStr(player.hand));

      assert(player.hand);
      playerInfo.push({ name: player.name, id: player.id, hand: player.hand, isBot: player.isBot });
    }

    return({
        type: "GameStateUpdate", 
        version: this.stateVersion,
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
    
    if (msg.handNumber === this.handNumber && msg.playerId === this.currentPlayer.id) {
      this.updateGameState(msg.board, msg.buckets, msg.hand);
      this.broadcastGameState(ws);
    } else {
      console.log("receiveStateUpdate: got (" + msg.handNumber, ", " + msg.playerId + 
                  ") want (" + this.handNumber + ", " + this.currentPlayer.id + ")");
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
    broadcastGameConfigs();
    return true;
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
    var players = [];
    for (let player of this.playerMap.values()) {
      players.push(new PlayerInfo(player.name, player.isBot, player.webSocket !== null));
    }
    configs.push(new GameInfo(this.gameName, this.cardsPerHand, players));
  }

  handDone(ws, msg) {
    if (msg.playerId !== this.currentPlayer.id) {
      return sendError(ws, msg, 
                       "Invalid player id:" + msg.playerId + "!==" + this.currentPlayer.id);
    } else if (msg.handNumber !== this.handNumber) {
      return sendError(ws, msg, 
                       "Invalid hand number:" + msg.handNumber + "!==" + this.handNumber);
    }
    sendSuccess(ws, msg);
    if (msg.drawCard) {
      this.drawCard(this.currentPlayer.hand);
    } else {
      this.currentPlayer.hand = msg.hand;
    }
    this.updateGameState(msg.board, [[]]);
    this.broadcastGameState();

    if (this.currentPlayer.hand.length === 0) {
      this.resetGameState();
      broadcastGameConfigs();
    } else {
      this.nextPlayerIndex++;
      if (this.nextPlayerIndex === this.playerOrder.length) {
        this.nextPlayerIndex = 0;
      }
      this.handNumber++;
      this.playHand();
    }
  }

  playHand() {        
    let player = this.playerMap.get(this.playerOrder[this.nextPlayerIndex]);
    this.currentPlayer = player;
    this.sendPlayHandMsg();
  }

  sendPlayHandMsg() {
    var msg = {
      type: "PlayHand", 
      playerId: this.currentPlayer.id,
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

function processDeleteGameMsg(ws, msg) {
  let game = lookupGame(ws, msg);
  if (game) {
    var errMsg = game.canDeleteGame();
    if (errMsg) {
      return sendError(ws, msg, errMsg);
    } else {
      gameMap.delete(msg.gameName);
      let filePath = GAME_CONFIG_DIR + msg.gameName;
      fs.rm(filePath, err => {
        if (err) {
          console.log("Failed to remove file", filePath);
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
  let tFilePath = GAME_CONFIG_DIR + "_" + msg.config.gameName;
  let filePath = GAME_CONFIG_DIR + msg.config.gameName;
  fs.writeFile(tFilePath, JSON.stringify(msg.config), err => {
    if (err) {
      console.error("writeFile of " + tFilePath + " failed with", err);
    } else {
      fs.rename(tFilePath, filePath, err => {
        if (err) {
          console.log("rename of " + tFilePath + " to " + filePath + " failed with", err);
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

fs.readdir(GAME_CONFIG_DIR, function(err, filenames) {
  if (err) {
    console.log("Error opening", GAME_CONFIG_DIR, err);
    return;
  }

  filenames.forEach((fileName) => {
    var path = GAME_CONFIG_DIR + fileName;
    fs.readFile(path, 'utf-8', function(err, content) {
      if (err) {
        console.log("Error reading file", path)
        return;
      } else if (fileName[0] === '_') {
        fs.rm(path, () => {});
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
    });
  });
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
