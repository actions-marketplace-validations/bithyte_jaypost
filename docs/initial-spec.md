# Telegram Approval Bot

## Telegram Bot

- Connects to Telegram.
- Can be containerized
- Can be installed as a service on a linux machine (this one as a MVP)
- Has an API
- Has a setup phase

## API

- Exposed only locally

### API Endpoint

POST /request
 - body has "text" attibute of type string
 - body has "options" attribute of type string[]
 - body has "timeoutOption" attribute of type string

Request has a global max timeout (5 minutes) that will trigger a decline
Request stays alive until either the bot has got an answer or the timeout has been triggered for that question.
The bot supports multiple requests.

## Testing script

- Calls the /request endpoint with text: "This is a test". Options: "Approve", "Decline"
- Prints out response

## Unknowns
 - Can the telegram bot support dynamic options for answer or does it need reload?

