Simple Redis DNS
================

A simple redis dns implementation.

Built for use simple dev use cases.

_This isn't really written for general use. YMMV._

Examples
--------

Run the server with docker-compose:

    docker-compose up

Add an A record for something.dev as 127.0.0.1:

    docker-compose run app npm run add a something.dev 127.0.0.1

Remove that record again:

    docker-compose run app npm run remove a something.dev 127.0.0.1

Add a few records (splits whenever a type is encountered):

    docker-compose run app npm run add a something.dev something2.dev \
      127.0.0.1 ns something.dev 127.0.0.1 a somewhereelse.dev 10.0.0.1

Remove a few records (splits whenever a type is encountered):

    docker-compose run app npm run remove a something.dev something2.dev \
      127.0.0.1 ns something.dev 127.0.0.1 a somewhereelse.dev 10.0.0.1

Lookup eg:

    dig something.dev @{{ app container ip }}

Random notes
------------

The redis data is saved ./data using the appendonlyformat option, by default.
(Edit docker-compose.yml to change that functionality.)
