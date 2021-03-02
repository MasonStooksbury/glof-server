// As obviously told by the name of the file, this is the server

const Express = require('express')();
const Http = require('http').Server(Express);
const io = require('socket.io')(Http);
const cors = require('cors');

Http.listen(8080, () => {
    console.log('Listening at :8080...');
});

Express.use(cors());


io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        room = io.sockets.adapter.rooms[data.room];

        // The joining player passes in a string (helpful on the client end) but we need a number
        if (typeof(data.room) === 'string') {
            data.room = parseInt(data.room)
        }

        // If the room already has two people in it, don't let anyone else join
        if (room != undefined && room.length == 2) {
            return;
        }

        // Actually join the room (and thus create it in Socket.IO)
        socket.join(data.room);

        // Only the first player needs to setup the data.room
        if (io.sockets.adapter.rooms[data.room].player1 == undefined) {
            setUpRoom(data.room);
        }

        // Save the socket reference 
        io.sockets.adapter.rooms[data.room].socketReference = socket;
        // console.log(data.room);

        // Assign players as they connect
        if (room.player1.socketId === '') {
            room.player1.socketId = socket.id;
            room.player1.socket = socket;
            room.player_array.push(room.player1);

            toSpecificSocket({id: socket.id, method: 'clientConnection', message: {message: 'Welcome to Glof! You are Player 1', player_id: '1'}});
        } else {
            room.player2.socketId = socket.id;
            room.player2.socket = socket;
            room.player_array.push(room.player2);
            
            toSpecificSocket({id: socket.id, method: 'clientConnection', message: {message: 'Welcome to Glof! You are Player 2', player_id: '2'}});
        }
        room.players++;
    })

    // This triggers whenever a player hits the ready up button.
    socket.on('playerReadyUp', (data) => {
        room = io.sockets.adapter.rooms[data.room];
        room.socketReference = socket;
        // Set this socket to "ready"
        room.player_array.find(player => player.socketId === socket.id).isReady = true;

        // When both players are ready, start the main game and send the discard card
        if (room.player1.isReady && room.player2.isReady) {
            shuffleDeckAndAssign(room);
            // Assign players their cards
            room.discard_pile = room.draw_pile.shift();
            toEveryoneInRoom(data.room, 'updateDrawPileCount', room.draw_pile.length)
            toEveryoneInRoom(data.room, 'startGame', room.discard_pile);
        }
    })

    // This is the beginning of the game where each player chooses two cards they want
    //      to reveal
    socket.on('chooseCard', data => {
        room = io.sockets.adapter.rooms[data.room];
        room.socketReference = socket;
        current_player = room.player_array.find(player => player.socketId === socket.id);

        if (current_player.chosenCards < 2) {
            // Increment the number of cards they've chosen
            current_player.chosenCards++;

            // Fill their display deck with the card they chose
            current_player.display_cards[data.index] = current_player.cards[data.index];
            
            // Send them their choice so they can see it
            toSpecificSocket({id: current_player.socketId, method: 'receiveCard', message: {card: current_player.display_cards[data.index], index: data.index}});
        }

        // Once both players have chosen their cards, send each player the opposing player's display deck
        //      and begin the game
        if (room.player1.chosenCards === 2 && room.player2.chosenCards === 2) {
            // console.log('sent cards');
            // Send each player the other person's cards
            toSpecificSocket({id: room.player1.socketId, method: 'receiveOtherCards', message: room.player2.display_cards});
            toSpecificSocket({id: room.player2.socketId, method: 'receiveOtherCards', message: room.player1.display_cards});

            // End the choose-2 phase and begin the main game
            toEveryoneInRoom(data.room, 'startTurns', true);
            if (room.turn) {
                toSpecificSocket({id: room.player1.socketId, method: 'notifyTurn', message: 'Your turn!'});
            } else {
                toSpecificSocket({id: room.player2.socketId, method: 'notifyTurn', message: 'Your turn!'});
            }
        }
    })

    // This is where the logic for turn-taking happens
    socket.on('playerTurn', data => {
        room = io.sockets.adapter.rooms[data.room];
        room.socketReference = socket;
        // Only allow players to do things on their turn
        if (room.turn && socket.id === room.player1.socketId || !room.turn && socket.id === room.player2.socketId) {
            current_player = room.player_array.find(player => player.socketId === socket.id);
            // If their action was to draw a card from the draw pile
            if (data.action === 'drawFromDrawPile') {
                // console.log('card drawn');
                // Take a card off the top of the draw pile and send it to the player
                room.top_of_draw_pile = room.draw_pile.shift()

                toSpecificSocket({id: current_player.socketId, method: 'receiveDrawCard', message: room.top_of_draw_pile});
                // Update the number of cards in the draw pile so everyone can see it
                toEveryoneInRoom(data.room, 'updateDrawPileCount', room.draw_pile.length);
            }
            // Or if their action was to replace a card in their grid
            else if (data.action === 'replace') {
                // console.log('card replaced');

                // Did the new card come from the discard pile or the top of the draw pile?
                new_card = data.fromDiscardOrNah ? room.discard_pile : room.top_of_draw_pile;

                // Change the discard pile to be the player's old card
                room.discard_pile = current_player.cards[data.data]

                // Change their card deck and their display deck to have the new card
                current_player.display_cards[data.data] = new_card;
                current_player.cards[data.data] = new_card;

                // console.log(`discard pile: ${discard_pile}`);
                // console.log(`display cards: ${current_player.display_cards}`);
                // console.log(`cards: ${current_player.cards}`);

                // Send everyone their deck and their opponent's deck
                updateAllCards(room);
                // Update the discard card
                toEveryoneInRoom(data.room, 'receiveDiscardCard', room.discard_pile);

                // Change turns
                changeTurn(room, data.room, current_player);

            }
            // Or if their action was to discard a card
            // I know, I know "mAsOn ThErE aRe OnLy ThReE oPtIoNs. JuSt UsE aN eLsE", I get it.
            //      Really the only reason I did this was for clarity; you're welcome
            else if (data.action === 'discard') {
                // console.log('card discarded');
                room.discard_pile = room.top_of_draw_pile;
                toEveryoneInRoom(data.room, 'receiveDiscardCard', room.discard_pile);

                changeTurn(room, data.room, current_player);
            }
        }
    });

    // Trigger the next round
    socket.on('nextRound', (data) => {
        room = io.sockets.adapter.rooms[data.room];
        room.socketReference = socket;
        // Only player 1 is allowed to do this
        if (socket.id === room.player1.socketId) {
            reset(room, data.room);
            toEveryoneInRoom(data.room, 'nextRoundStart');
        }
    })

    // Trigger a new game
    socket.on('newGame', (data) => {
        room = io.sockets.adapter.rooms[data.room];
        room.socketReference = socket;
        // Only player 1 is allowed to do this
        if (socket.id === room.player1.socketId) {
            reset(room, data.room, 'score');
            toEveryoneInRoom(data.room, 'nextGameStart');
        }
    })

    // If one player leaves a room, kick the other player out and send them back to the main menu
    socket.on('disconnecting', function() {
        // Capture the room ID so we can leave later
        room_id = Object.keys(socket.rooms)[0];
        // Grab the room from the io object
        room = io.sockets.adapter.rooms[room_id];

        // Kick remaining player back to the lobby so they can start a new game or quit
        toEveryoneInRoom(room_id, 'kickToLobby');
        // console.log(room);
        // Kick everyone out of the room (I tried several different ways of doing this, and this was the most bulletproof)
        try {
            room.player1.socket.leave(room_id);
        } catch (e) {
            console.log(':)');
        }
        try {
            room.player2.socket.leave(room_id);
        } catch (e) {
            console.log(':)');
        }
    });
});


// Change turns and update stuff
function changeTurn(room, room_id, current_player) {
    // If it's the last turn
    if (current_player.isLastTurn) {
        // console.log('last turn?');
        endGame(room, room_id);
    } 
    // Otherwise, change turns
    else {
        // If there are no more face-down cards, get ready to warn the remaining players that it is their last turn
        if (!current_player.display_cards.includes('')) {
            room.player1.isLastTurn = true;
            room.player2.isLastTurn = true;
        }

        // After player 1 is finished, warn player 2 or make it their turn
        if (room.turn && room.socketReference.id === room.player1.socketId) {
            room.turn = false;
            if (current_player.isLastTurn) {
                toSpecificSocket({id: room.player2.socketId, method: 'notifyLastTurn', message: 'Last turn!'});
            } else {
                toSpecificSocket({id: room.player2.socketId, method: 'notifyTurn', message: 'Your turn!'});
            }
        } 
        // Otherwise after player 2 is finished, warn player 1 or make it their turn
        else if (!room.turn && room.socketReference.id === room.player2.socketId) {
            room.turn = true;
            if (current_player.isLastTurn) {
                toSpecificSocket({id: room.player1.socketId, method: 'notifyLastTurn', message: 'Last turn!'});
            } else {
                toSpecificSocket({id: room.player1.socketId, method: 'notifyTurn', message: 'Your turn!'});
            }
        }
    }
}

// Update all hands and display cards
function updateAllCards(room) {
    toSpecificSocket({id: room.player1.socketId, method: 'receiveOtherCards', message: room.player2.display_cards});
    toSpecificSocket({id: room.player2.socketId, method: 'receiveOtherCards', message: room.player1.display_cards});

    toSpecificSocket({id: room.player1.socketId, method: 'updateCards', message: room.player1.display_cards});
    toSpecificSocket({id: room.player2.socketId, method: 'updateCards', message: room.player2.display_cards});
}

// Prepare everything for the next game
function reset(room, room_id, resetPlayers) {
    var doSetup = true;
    if (resetPlayers === 'scoreAndId') {
        room.player1 = {socketId: '', score: 0, isReady: false, chosenCards: 0, isLastTurn: false, display_cards: ['', '', '', '', '', ''], cards: ['', '', '', '', '', '']};
        room.player2 = {socketId: '', score: 0, isReady: false, chosenCards: 0, isLastTurn: false, display_cards: ['', '', '', '', '', ''], cards: ['', '', '', '', '', '']};
        doSetup = false;
        room.player1Start = true;
        room.turn = true;
    } else if (resetPlayers === 'score') {
        room.player1 = {socketId: room.player1.socketId, score: 0, isReady: false, chosenCards: 0, isLastTurn: false, display_cards: ['', '', '', '', '', ''], cards: ['', '', '', '', '', '']};
        room.player2 = {socketId: room.player2.socketId, score: 0, isReady: false, chosenCards: 0, isLastTurn: false, display_cards: ['', '', '', '', '', ''], cards: ['', '', '', '', '', '']};
    } else {
        room.player1 = {socketId: room.player1.socketId, score: room.player1.score, isReady: false, chosenCards: 0, isLastTurn: false, display_cards: ['', '', '', '', '', ''], cards: ['', '', '', '', '', '']};
        room.player2 = {socketId: room.player2.socketId, score: room.player2.score, isReady: false, chosenCards: 0, isLastTurn: false, display_cards: ['', '', '', '', '', ''], cards: ['', '', '', '', '', '']};
    }
    // console.log('player 1');
    // console.log(player1);
    // console.log('player 2');
    // console.log(player2);
    room.draw_pile = [];
    room.discard_pile = '';
    room.top_of_draw_pile = '';
    room.player_array = [room.player1, room.player2];

    room.turn = room.player1Start ? false : true;
    room.player1Start = room.player1Start ? false : true;

    if (doSetup) {
        shuffleDeckAndAssign(room);
        updateAllCards(room);
        room.discard_pile = room.draw_pile.shift();
        toEveryoneInRoom(room_id, 'receiveDiscardCard', room.discard_pile);
        toEveryoneInRoom(room_id, 'updateDrawPileCount', room.draw_pile.length);
    }
}

// Calculate scores, notify players, and reset
function endGame(room, room_id) {
    setScores(room);

    toSpecificSocket({id: room.player1.socketId, method: 'revealCards', message: {yours: room.player1.cards, theirs: room.player2.cards}});
    toSpecificSocket({id: room.player2.socketId, method: 'revealCards', message: {yours: room.player2.cards, theirs: room.player1.cards}});

    // If player 1 won
    if ((room.player1.score < room.player2.score && room.player1.score <= -100) || (room.player1.score < room.player2.score && room.player2.score >= 100)) {
        toEveryoneInRoom(room_id, 'announceWinner', {message: 'Player 1 Wins!', p1Score: room.player1.score, p2Score: room.player2.score})
    } 
    // If player 2 won
    else if ((room.player2.score < room.player1.score && room.player2.score <= -100) || (room.player2.score < room.player1.score && room.player1.score >= 100)) {
        toEveryoneInRoom(room_id, 'announceWinner', {message: 'Player 2 Wins!', p1Score: room.player1.score, p2Score: room.player2.score})
    }
    // Otherwise, there is no winner and we can progress to the next round
    else {
        toEveryoneInRoom(room_id, 'roundSummary', {message: 'Round Summary', p1Score: room.player1.score, p2Score: room.player2.score});
    }
}





// I realize they are simple commands, but I found myself not being able to quickly
//      tell what was going on with these emissions. So I wrote obvious wrappers for
//      all of the ones I use

function toEveryoneInRoom(room, method, data) {
    // console.log(room);
    io.in(room).emit(method, data);
}

function toSpecificSocket(data) {
    io.to(data.id).emit(data.method, data.message);
}



// This function is used when someone clicks "Create Room"
function setUpRoom(roomId) {
    room = io.sockets.adapter.rooms[roomId];
    // The available deck of cards plus both Jokers (Z1 and Z2)
    room.cards = ['DA', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'DJ', 'DQ', 'DK',
    'SA', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'SJ', 'SQ', 'SK',
    'HA', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'HJ', 'HQ', 'HK',
    'CA', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'CJ', 'CQ', 'CK',
    'Z1', 'Z2'
    ];

    room.draw_pile = [];
    room.discard_pile = '';
    room.top_of_draw_pile = '';

    room.player1 = {socketId: '', socket: {}, room: 0, score: 0, isReady: false, chosenCards: 0, isLastTurn: false, display_cards: ['', '', '', '', '', ''], cards: ['', '', '', '', '', '']};
    room.player2 = {socketId: '', socket: {}, room: 0, score: 0, isReady: false, chosenCards: 0, isLastTurn: false, display_cards: ['', '', '', '', '', ''], cards: ['', '', '', '', '', '']};
    room.players = 0;
    room.player_array = [];

    // To make this easy, this will be in reference to player1
    // i.e.  'true' if it is player 1's turn, 'false' if not
    room.turn = true;

    room.player1Start = true;

    // Probably an architectural nightmare, but basically this gets changed all the time
    //      to whatever the current socket is. That way, I don't have to pass it to
    //      my socket wrapper methods
    room.socketReference = {};
}

// Shuffle the deck and give everyone their 6 cards from the top of the draw_pile
function shuffleDeckAndAssign(room) {
    // Create a deep copy of the cards (so we don't overwrite them)
    room.draw_pile = [...room.cards];
    // Shuffle them and fill the draw pile
    for(let i = room.draw_pile.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * i)
        const temp = room.draw_pile[i]
        room.draw_pile[i] = room.draw_pile[j]
        room.draw_pile[j] = temp
    }

    // console.log('cards');
    // console.log(cards);
    // console.log('\n\n\n\n');
    // console.log('draw');
    // console.log(draw_pile);

    // From the top of the draw pile, assign each player their 6 cards
    for(let i = 0; i < 6; i++) {
        room.player1.cards[i] = room.draw_pile.shift();
        room.player2.cards[i] = room.draw_pile.shift();
    }

    // console.log('\n\n\n\n');
    // console.log('player 1 cards');
    // console.log(player1.cards);
    // console.log('\n\n\n\n');
    // console.log('player 2 cards');
    // console.log(player2.cards);
}

// Used for scoring
// Convert the card letters to number values I can use (if you're wondering why I didn't just
//      use numbers to start with, it's because Jack, Queen, and 10 all have the same value)
function getCardValuesList(card_list) {
    card_scores = [];
    card_list.forEach(card => {
        if (card.includes('Z')) {
            card_scores.push(-25);
        } else if (card.includes('A')) {
            card_scores.push(1);
        } else if (card.includes('10')) {
            card_scores.push(10);
        } else if (card.includes('K')) {
            card_scores.push(0);
        } else if (card.includes('J') || card.includes('Q')) {
            card_scores.push(card[1]);
        } else {
            card_scores.push(parseInt(card[1], 10));
        }
    });
    return card_scores;
}

// Calculate the score for this round and add it to each player's total score
function setScores(room) {
    room.player1.score += calculateScore(getCardValuesList(room.player1.cards));
    room.player2.score += calculateScore(getCardValuesList(room.player2.cards));
    // console.log(player1.score);
    // console.log(player2.score);
}

// Actually do the score calculations
// This figures out each column, determines if blocks exist, etc
function calculateScore(card_scores) {
    blockPosition = 1;
    player_total_score = 0;
    
    columns = [
        [card_scores[0], card_scores[3]],
        [card_scores[1], card_scores[4]],
        [card_scores[2], card_scores[5]]
    ];

    // Check for blocks (2x2 of the same card)
    if (columns[0][0] === columns[0][1] && columns[1][0] === columns[1][1] && 
        columns[0][0] === columns[1][0] && columns[0][1] === columns[1][1]) {
        blockPosition = 2;
        player_total_score -= 25;
    } else if (columns[1][0] === columns[1][1] && columns[2][0] === columns[2][1] &&
                columns[1][0] === columns[2][0] && columns[1][1] === columns[2][1]) {
        blockPosition = 0;
        player_total_score -= 25;
    }

    // If there is a block, then score just the last remaining column
    if (blockPosition != 1) {
        if (columns[blockPosition][0] === -25 && columns[blockPosition][1] === -25) {
            player_total_score -= 50;
        } else if (columns[blockPosition].includes(2) && columns[blockPosition].includes(-25)) {
            player_total_score -= 25;
        } else if (columns[blockPosition].includes(2) || (columns[blockPosition][0] === columns[blockPosition][1])) {
            player_total_score += 0;
        } else if (columns[blockPosition].includes('J') && columns[blockPosition].includes('Q')) {
            player_total_score += 20;
        } else if (columns[blockPosition].includes('J') || columns[blockPosition].includes('Q')) {
            columns[blockPosition].forEach(item => {
                if (item != 'J' && item != 'Q') {
                    player_total_score += (10 + item);
                }
            });
        } else {
            player_total_score += (columns[blockPosition][0] + columns[blockPosition][1]);
        }
    } 
    // Otherwise, since there are no blocks, calculate each column individually and add them together
    else {
        columns.forEach(item => {
            if (item.includes(-25)) {
                count = 0;
                item.forEach(elem => {
                    if (elem === -25) {
                        count += 1;
                    }
                });
                if (count === 2) {
                    player_total_score -= 50;
                }
            }
            if (item.includes(2) && item.includes(-25)) {
                player_total_score -= 25;
            } else if (item.includes(2) || (item[0] === item[1])) {
                player_total_score += 0;
            } else if (item.includes('J') && item.includes('Q')) {
                player_total_score += 20;
            } else if (item.includes('J') || item.includes('Q')) {
                item.forEach(elem => {
                    if (elem != 'J' && elem != 'Q') {
                        player_total_score += (10 + elem);
                    }
                });
            } else {
                player_total_score += (item[0] + item[1]);
            }
        });
    }

    return player_total_score;
}


// Mason Stooksbury (2020) - rooms added in 2021
// <>< #!
